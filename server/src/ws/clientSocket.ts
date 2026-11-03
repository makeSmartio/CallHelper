// ---------------------------------------------------------------------------
// clientSocket.ts — handles a single WebSocket client connection.
//
// One instance per connected browser tab. Owns:
//   - the Deepgram transcription session
//   - the pyannote-based diarization scheduler
//   - the OpenAI prompt-on-rolling-transcript loop
//   - persistence of the finished session
// ---------------------------------------------------------------------------

import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import OpenAI from 'openai';
import { config } from '../config';
import { logLlmCall, LlmLogEntry } from '../lib/llmLog';
import { DeepgramService } from '../services/deepgram';
import { WhisperLocalService } from '../services/whisperLocal';
import { DiarizationClient, pickSpeakerForRange } from '../services/diarization';
import { TranscriptBuffer, TranscriptChunk } from '../lib/transcriptBuffer';
import { SessionAudioBuffer } from '../lib/audioBuffer';

// ---------------------------------------------------------------------------
// Wire-level message types
// ---------------------------------------------------------------------------
type SpeakerUpdate = { id: number; speaker: string | null };
const SELECTABLE_ANALYSIS_MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-4o-mini',
  'claude-haiku-5-5',
  'claude-sonnet-5-5',
  'grok-4.7',
]);

type ServerMessage =
  | {
      type: 'session_started';
      sessionId: string;
      mockMode: { deepgram: boolean; openai: boolean; diarization: boolean };
    }
  | {
      type: 'transcript';
      id?: number;
      text: string;
      isFinal: boolean;
      timestamp: number;
      speaker: string | null;
    }
  | {
      type: 'diarization_update';
      updates: SpeakerUpdate[];
      numSpeakers: number;
      tookMs: number;
    }
  | { type: 'status'; service: 'deepgram' | 'openai' | 'diarization'; status: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'session_saved'; sessionId: string; filePath: string }
  | { type: 'analysis'; result: string; timestamp: number }
  | {
      type: 'summary_status';
      status: 'started' | 'complete' | 'error';
      sections?: number;
      message?: string;
    }
  | { type: 'llm_log'; entry: LlmLogEntry };

export class ClientSocketHandler {
  private sessionId: string;
  private ws: WebSocket;
  private transcription: DeepgramService | WhisperLocalService;
  private transcriptBuffer: TranscriptBuffer;
  private audioBuffer: SessionAudioBuffer;
  private diarizer: DiarizationClient;

  private isSessionActive = false;
  private sessionStartedAt: number | null = null;
  // AI analysis is OFF by default — the user opts in via the Resume button
  // (or fires a single pass via Run Now / force_analysis). The client also
  // sends a set_analysis_paused on session_started to keep us in sync.
  private analysisPaused = true;
  // Speaker diarization is ON by default when the sidecar is configured.
  // The client can disable it per-session via set_diarization_enabled.
  private diarizationEnabled = true;

  private reasoningTimer: ReturnType<typeof setInterval> | null = null;
  private diarTimer: ReturnType<typeof setInterval> | null = null;
  private diarInFlight = false;
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;

  // LLM prompt loop. Clients are created on first use so a missing key
  // for one provider does not block the others.
  private llmClients: { openai: OpenAI | null; anthropic: OpenAI | null; xai: OpenAI | null } | null =
    null;
  private openaiInFlight = false;
  private summaryInFlight = false;
  private analysisModel = config.openAiModel;
  private customPrompt = '';
  private analysisResults: Array<{ result: string; timestamp: number }> = [];

  // User-supplied context that survives across messages within a connection
  // (the client resends all of these on session_started so they're never lost).
  private speakerAliases: Record<string, string> = {};
  private speakerMerges: Record<string, string> = {};
  private userNotes = '';

  constructor(ws: WebSocket) {
    this.sessionId = uuidv4();
    this.ws = ws;
    this.transcription = config.useLocalWhisper
      ? new WhisperLocalService()
      : new DeepgramService();
    this.transcriptBuffer = new TranscriptBuffer();
    this.audioBuffer = new SessionAudioBuffer();
    this.diarizer = new DiarizationClient();
    this.setupWebSocketListeners();
    console.log(`[WS] Client connected — session: ${this.sessionId}`);
  }

  private setupWebSocketListeners(): void {
    this.ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        this.handleAudio(data as Buffer);
      } else {
        try {
          const msg = JSON.parse(data.toString());
          this.handleControlMessage(msg);
        } catch {
          console.warn(`[WS] ${this.sessionId} — invalid JSON message`);
        }
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(
        `[WS] Client disconnected — session: ${this.sessionId}, code: ${code}, reason: ${reason.toString()}`
      );
      void this.onDisconnect();
    });

    this.ws.on('error', (err) => {
      console.error(`[WS] ${this.sessionId} — socket error:`, err.message);
    });
  }

  private handleControlMessage(msg: {
    type: string;
    prompt?: string;
    paused?: boolean;
    enabled?: boolean;
    source?: string;
    aliases?: Record<string, string>;
    merges?: Record<string, string>;
    notes?: string;
    model?: string;
    transcriptChunks?: Array<{
      text?: unknown;
      timestamp?: unknown;
      speaker?: unknown;
      isFinal?: unknown;
    }>;
  }): void {
    switch (msg.type) {
      case 'start_session':
        void this.startSession();
        break;
      case 'stop_session':
        void this.stopSession();
        break;
      case 'load_transcript': {
        const chunks = Array.isArray(msg.transcriptChunks)
          ? msg.transcriptChunks
              .slice(-10000)
              .filter((chunk) => chunk.isFinal !== false && typeof chunk.text === 'string')
              .map((chunk) => ({
                text: (chunk.text as string).slice(0, 20000),
                timestamp:
                  typeof chunk.timestamp === 'number' && Number.isFinite(chunk.timestamp)
                    ? chunk.timestamp
                    : Date.now(),
                speaker:
                  typeof chunk.speaker === 'string'
                    ? chunk.speaker.trim().slice(0, 80) || null
                    : null,
              }))
          : [];
        this.transcriptBuffer.replaceFinalChunks(chunks);
        console.log(
          `[WS] ${this.sessionId} — imported transcript loaded (${chunks.length} chunks, ` +
          `${this.transcriptBuffer.getTotalFinalText().length} chars)`
        );
        break;
      }
      case 'set_model':
        if (typeof msg.model === 'string' && SELECTABLE_ANALYSIS_MODELS.has(msg.model)) {
          this.analysisModel = msg.model;
          console.log(`[WS] ${this.sessionId} — analysis model set to ${msg.model}`);
        }
        break;
      case 'set_prompt':
        this.customPrompt = typeof msg.prompt === 'string' ? msg.prompt : '';
        console.log(
          `[WS] ${this.sessionId} — custom prompt updated (${this.customPrompt.length} chars)`
        );
        break;
      case 'set_analysis_paused':
        this.analysisPaused = msg.paused === true;
        console.log(
          `[WS] ${this.sessionId} — analysis ${this.analysisPaused ? 'paused' : 'resumed'} (transcription continues)`
        );
        break;
      case 'set_diarization_enabled':
        this.applyDiarizationEnabled(msg.enabled !== false);
        break;
      case 'set_speaker_aliases': {
        const aliases = msg.aliases && typeof msg.aliases === 'object' ? msg.aliases : {};
        // Only keep non-empty string values; sanity-cap the map size.
        const cleaned: Record<string, string> = {};
        for (const [k, v] of Object.entries(aliases)) {
          if (typeof v === 'string' && v.trim().length > 0) {
            cleaned[k] = v.trim().slice(0, 80);
          }
        }
        this.speakerAliases = cleaned;
        console.log(
          `[WS] ${this.sessionId} — speaker aliases set (${Object.keys(cleaned).length} entries)`
        );
        break;
      }
      case 'set_speaker_merges': {
        const merges = msg.merges && typeof msg.merges === 'object' ? msg.merges : {};
        const cleaned: Record<string, string> = {};
        for (const [k, v] of Object.entries(merges)) {
          if (typeof v === 'string' && v.trim().length > 0 && v.trim() !== k) {
            cleaned[k] = v.trim().slice(0, 80);
          }
        }
        this.speakerMerges = cleaned;
        console.log(
          `[WS] ${this.sessionId} — speaker merges set (${Object.keys(cleaned).length} entries)`
        );
        break;
      }
      case 'set_notes':
        this.userNotes = typeof msg.notes === 'string' ? msg.notes.slice(0, 8000) : '';
        console.log(
          `[WS] ${this.sessionId} — notes updated (${this.userNotes.length} chars)`
        );
        break;
      case 'force_analysis': {
        const isSilenceTrigger = msg.source === 'silence';
        const ignoreAnalysisPause = !isSilenceTrigger;
        console.log(
          `[WS] ${this.sessionId} — forced analysis (source: ${isSilenceTrigger ? 'silence' : 'user'})`
        );
        void this.runReasoningIfReady(true, { ignoreAnalysisPause });
        break;
      }
      case 'summarize_call':
        void this.summarizeEntireCall();
        break;
      default:
        console.warn(`[WS] ${this.sessionId} — unknown message type: ${msg.type}`);
    }
  }

  private handleAudio(data: Buffer): void {
    if (!this.isSessionActive) return;
    this.audioBuffer.append(data);
    this.transcription.sendAudio(data);
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------
  private async startSession(): Promise<void> {
    if (this.isSessionActive) {
      console.warn(`[WS] ${this.sessionId} — start_session called while already active`);
      return;
    }

    console.log(`[WS] ${this.sessionId} — starting copilot session`);
    this.sessionStartedAt = Date.now();
    // Note: analysisPaused is NOT reset here — it reflects the client's
    // current preference, which the client resends on session_started.
    this.transcriptBuffer.clear();
    this.audioBuffer.clear();
    this.diarizer.reset();
    this.analysisResults = [];

    try {
      const serviceName = config.useLocalWhisper ? 'WhisperLocal' : 'Deepgram';
      console.log(`[WS] ${this.sessionId} — connecting ${serviceName}...`);
      await this.transcription.start(
        (chunk) => this.onTranscript(chunk),
        (status) => {
          console.log(`[WS] ${this.sessionId} — ${serviceName} status: ${status}`);
          this.send({ type: 'status', service: 'deepgram', status });
        }
      );
      console.log(`[WS] ${this.sessionId} — ${serviceName} connected OK`);
    } catch (err) {
      const serviceName = config.useLocalWhisper ? 'WhisperLocal' : 'Deepgram';
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[WS] ${this.sessionId} — ${serviceName} connect FAILED:`, message);
      this.send({ type: 'error', code: 'TRANSCRIPTION_CONNECT_FAILED', message });
      return;
    }

    this.isSessionActive = true;
    this.send({
      type: 'session_started',
      sessionId: this.sessionId,
      mockMode: {
        deepgram: config.useMockDeepgram,
        openai: config.useMockOpenAI,
        diarization: !config.useDiarization,
      },
    });

    if (this.isDiarizationActive()) {
      this.send({ type: 'status', service: 'diarization', status: 'idle' });
    } else {
      this.send({ type: 'status', service: 'diarization', status: 'disconnected' });
    }

    this.startReasoningLoop();
    this.startDiarizationLoop();
    this.startAutosaveLoop();
  }

  private async stopSession(): Promise<void> {
    if (!this.isSessionActive) return;

    console.log(`[WS] ${this.sessionId} — stopping session`);
    this.stopAutosaveLoop();
    this.isSessionActive = false;

    if (this.reasoningTimer) {
      clearInterval(this.reasoningTimer);
      this.reasoningTimer = null;
    }
    this.stopDiarizationLoop();

    await this.transcription.stop();

    // Final diarization pass on the full audio so the saved transcript has
    // the best labels we can produce.
    if (this.isDiarizationActive() && this.audioBuffer.byteLength() > 0) {
      console.log(`[WS] ${this.sessionId} — running final diarization pass...`);
      await this.runDiarization({ full: true });
    }
    await this.runReasoningIfReady(true, { ignoreAnalysisPause: true });
    await this.saveSession();
  }

  // ---------------------------------------------------------------------------
  // Autosave (periodic + emergency on disconnect)
  // ---------------------------------------------------------------------------
  private startAutosaveLoop(): void {
    this.stopAutosaveLoop();
    this.autosaveTimer = setInterval(() => {
      void this.persistAutosave();
    }, config.sessionAutosaveIntervalMs);
  }

  private stopAutosaveLoop(): void {
    if (this.autosaveTimer) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = null;
    }
  }

  private buildSessionPayload(options: {
    autosave: boolean;
    endedAt?: number;
    disconnectAbnormal?: boolean;
  }): Record<string, unknown> {
    const data: Record<string, unknown> = {
      sessionId: this.sessionId,
      mode: 'copilot',
      startedAt: this.sessionStartedAt,
      finalTranscript: this.transcriptBuffer.getTotalFinalText(),
      transcriptChunks: this.transcriptBuffer.getFinalChunks(),
      customPrompt: this.customPrompt,
      analysisModel: this.analysisModel,
      analysisResults: this.analysisResults,
      speakerAliases: this.speakerAliases,
      speakerMerges: this.speakerMerges,
      notes: this.userNotes,
    };
    if (options.autosave) {
      data.autosave = true;
      data.autosaveAt = Date.now();
      if (options.disconnectAbnormal) {
        data.disconnectAbnormal = true;
      }
    } else {
      data.autosave = false;
      data.endedAt = options.endedAt ?? Date.now();
    }
    return data;
  }

  private removeAutosaveArtifacts(): void {
    const jsonPath = path.join(config.sessionDir, `${this.sessionId}.autosave.json`);
    const wavPath = path.join(config.sessionDir, `${this.sessionId}.autosave.wav`);
    for (const p of [jsonPath, wavPath]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }

  private async persistAutosave(options?: { disconnect?: boolean }): Promise<void> {
    if (this.sessionStartedAt == null) return;
    const chunks = this.transcriptBuffer.getFinalChunks();
    const hasAudio = this.audioBuffer.byteLength() > 0;
    if (chunks.length === 0 && !hasAudio && !options?.disconnect) return;

    const sessionData = this.buildSessionPayload({
      autosave: true,
      disconnectAbnormal: options?.disconnect === true,
    });
    const jsonPath = path.join(config.sessionDir, `${this.sessionId}.autosave.json`);

    try {
      fs.mkdirSync(config.sessionDir, { recursive: true });
      fs.writeFileSync(jsonPath, JSON.stringify(sessionData, null, 2));
      if (hasAudio) {
        const wavPath = path.join(config.sessionDir, `${this.sessionId}.autosave.wav`);
        fs.writeFileSync(wavPath, this.audioBuffer.toWav());
      }
      if (options?.disconnect) {
        console.log(`[Session] Emergency autosave written: ${jsonPath}`);
      }
    } catch (err) {
      console.error('[Session] Autosave failed:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Transcription
  // ---------------------------------------------------------------------------
  private onTranscript(input: {
    text: string;
    isFinal: boolean;
    timestamp: number;
    audioStart: number | null;
    audioEnd: number | null;
  }): void {
    if (input.isFinal) {
      const chunk = this.transcriptBuffer.addFinal({
        text: input.text,
        timestamp: input.timestamp,
        audioStart: input.audioStart,
        audioEnd: input.audioEnd,
      });
      this.send({
        type: 'transcript',
        id: chunk.id,
        text: chunk.text,
        isFinal: true,
        timestamp: chunk.timestamp,
        speaker: chunk.speaker,
      });
    } else {
      this.transcriptBuffer.addPartial(input.text, input.timestamp);
      this.send({
        type: 'transcript',
        text: input.text,
        isFinal: false,
        timestamp: input.timestamp,
        speaker: null,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Diarization loop
  // ---------------------------------------------------------------------------
  private isDiarizationActive(): boolean {
    return config.useDiarization && this.diarizationEnabled;
  }

  private applyDiarizationEnabled(enabled: boolean): void {
    this.diarizationEnabled = enabled;
    console.log(
      `[WS] ${this.sessionId} — diarization ${enabled ? 'enabled' : 'disabled'} by client` +
        (config.useDiarization ? '' : ' (sidecar not configured)')
    );

    if (!this.isSessionActive) return;

    if (this.isDiarizationActive()) {
      if (!this.diarTimer) this.startDiarizationLoop();
      this.send({ type: 'status', service: 'diarization', status: 'idle' });
    } else {
      this.stopDiarizationLoop();
      this.send({ type: 'status', service: 'diarization', status: 'disconnected' });
    }
  }

  private startDiarizationLoop(): void {
    if (!this.isDiarizationActive()) return;
    if (this.diarTimer) return;

    this.diarTimer = setInterval(async () => {
      if (!this.isSessionActive || !this.isDiarizationActive()) return;
      if (this.audioBuffer.durationSeconds() < 2) return;
      await this.runDiarization();
    }, config.diarizationIntervalMs);
  }

  private stopDiarizationLoop(): void {
    if (this.diarTimer) {
      clearInterval(this.diarTimer);
      this.diarTimer = null;
    }
  }

  private async runDiarization(opts?: { full?: boolean }): Promise<void> {
    if (!this.isDiarizationActive()) return;
    if (this.diarInFlight) {
      console.log(`[WS] ${this.sessionId} — skipping diarization (still in flight)`);
      return;
    }
    this.diarInFlight = true;
    this.send({ type: 'status', service: 'diarization', status: 'running' });

    try {
      // Periodic passes only send a trailing window of audio so per-pass
      // compute stays bounded on long calls; the final pass (session stop)
      // uses the whole session for the best possible last-word labeling.
      const { wav, windowStartSeconds } = opts?.full
        ? { wav: this.audioBuffer.toWav(), windowStartSeconds: 0 }
        : this.audioBuffer.getWindowWav(config.diarizationWindowSeconds);
      const result = await this.diarizer.diarize(wav, windowStartSeconds);
      if (!result) {
        this.send({ type: 'status', service: 'diarization', status: 'error' });
        return;
      }

      const changedIds = this.transcriptBuffer.applySpeakerLabels((chunk: TranscriptChunk) => {
        if (chunk.audioStart == null || chunk.audioEnd == null) return chunk.speaker;
        const raw = pickSpeakerForRange(result.segments, chunk.audioStart, chunk.audioEnd);
        return this.diarizer.labelFor(raw) ?? chunk.speaker;
      });

      if (changedIds.length > 0) {
        const allChunks = this.transcriptBuffer.getFinalChunks();
        const updates: SpeakerUpdate[] = allChunks
          .filter((c) => changedIds.includes(c.id))
          .map((c) => ({ id: c.id, speaker: c.speaker }));
        this.send({
          type: 'diarization_update',
          updates,
          numSpeakers: result.num_speakers,
          tookMs: result.took_ms,
        });
      }

      this.send({ type: 'status', service: 'diarization', status: 'connected' });
      console.log(
        `[Diarization] ${this.sessionId} — ${result.num_speakers} speakers, ` +
          `${changedIds.length} chunk labels updated, ${result.took_ms} ms`
      );
    } finally {
      this.diarInFlight = false;
    }
  }

  // ---------------------------------------------------------------------------
  // LLM prompt-on-transcript loop
  // ---------------------------------------------------------------------------
  private providerForModel(model: string): 'openai' | 'anthropic' | 'xai' {
    if (model.startsWith('claude-')) return 'anthropic';
    if (model.startsWith('grok-')) return 'xai';
    return 'openai';
  }

  private getLlmClients(): { openai: OpenAI | null; anthropic: OpenAI | null; xai: OpenAI | null } {
    if (!this.llmClients) {
      this.llmClients = {
        openai: config.openAiApiKey ? new OpenAI({ apiKey: config.openAiApiKey }) : null,
        anthropic: config.anthropicApiKey
          ? new OpenAI({
              apiKey: config.anthropicApiKey,
              baseURL: 'https://api.anthropic.com/v1/',
            })
          : null,
        xai: config.xaiApiKey
          ? new OpenAI({ apiKey: config.xaiApiKey, baseURL: 'https://api.x.ai/v1' })
          : null,
      };
    }
    return this.llmClients;
  }

  private async completeAnalysis(
    systemPrompt: string,
    userContent: string,
    maxCompletionTokens: number
  ): Promise<
    | {
        text: string;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      }
    | 'mock'
  > {
    const provider = this.providerForModel(this.analysisModel);
    const client = this.getLlmClients()[provider];
    if (!client) {
      if (provider === 'openai') return 'mock';
      const envName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'XAI_API_KEY';
      throw new Error(`Set ${envName} in server/.env to use ${this.analysisModel}.`);
    }

    const response = await client.chat.completions.create({
      model: this.analysisModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      max_completion_tokens: maxCompletionTokens,
    });

    return {
      text: response.choices[0]?.message?.content ?? '',
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    };
  }

  private startReasoningLoop(): void {
    this.reasoningTimer = setInterval(async () => {
      await this.runReasoningIfReady(false);
    }, config.reasoningIntervalMs);
  }

  private async runReasoningIfReady(
    force = false,
    options?: { ignoreAnalysisPause?: boolean }
  ): Promise<void> {
    if (this.analysisPaused && !options?.ignoreAnalysisPause) return;

    const newChars = this.transcriptBuffer.newCharsSinceLastReasoning();
    if (!force && newChars < config.minNewCharsForReasoning) return;
    if (this.transcriptBuffer.isEmpty() && !force) return;
    if (this.openaiInFlight) return;
    if (!this.customPrompt.trim()) return;

    const rollingTranscript = this.transcriptBuffer.getRollingWindow(
      config.transcriptWindowChars,
      this.speakerAliases,
      this.speakerMerges
    );
    this.transcriptBuffer.markReasoningCalled();

    this.openaiInFlight = true;
    const timestamp = Date.now();
    const startTime = Date.now();
    const systemPrompt =
      'You are a helpful assistant analyzing a live conversation transcript. Be concise and direct.';
    const userPrompt = this.customPrompt.trim();
    const notesBlock = this.userNotes.trim();
    const userContent = [
      userPrompt,
      notesBlock ? `\nMY NOTES (user-supplied context, treat as authoritative):\n---\n${notesBlock}\n---` : '',
      `\nTRANSCRIPT:\n---\n${rollingTranscript || '(no transcript yet)'}\n---`,
    ]
      .filter(Boolean)
      .join('\n');

    console.log(
      `[WS] ${this.sessionId} — reasoning call (prompt: ${userPrompt.length} chars, transcript: ${rollingTranscript.length} chars)`
    );

    try {
      let result: string;
      let promptTokens = 0;
      let completionTokens = 0;
      let totalTokens = 0;

      const completion = await this.completeAnalysis(systemPrompt, userContent, 2000);
      if (completion === 'mock') {
        await new Promise((r) => setTimeout(r, 500));
        result = `[Mock] Transcript length: ${rollingTranscript.length} chars. Prompt: "${userPrompt.slice(0, 60)}${userPrompt.length > 60 ? '…' : ''}"`;
      } else {
        result = completion.text || '(no response)';
        promptTokens = completion.promptTokens;
        completionTokens = completion.completionTokens;
        totalTokens = completion.totalTokens;
      }

      const durationMs = Date.now() - startTime;
      const logEntry = logLlmCall({
        sessionId: this.sessionId,
        mode: 'copilot',
        timestamp,
        model: this.analysisModel,
        systemPrompt,
        userPrompt: userContent,
        response: result,
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs,
      });

      this.analysisResults.push({ result, timestamp });
      this.send({ type: 'analysis', result, timestamp });
      this.send({ type: 'llm_log', entry: logEntry });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[WS] ${this.sessionId} — reasoning error:`, message);
      this.send({ type: 'error', code: 'ANALYSIS_FAILED', message });
    } finally {
      this.openaiInFlight = false;
    }
  }

  private splitTranscript(transcript: string, maxChars = 24000): string[] {
    const sections: string[] = [];
    let current = '';

    for (const line of transcript.split('\n')) {
      const parts: string[] = [];
      if (line.length <= maxChars) {
        parts.push(line);
      } else {
        for (let offset = 0; offset < line.length; offset += maxChars) {
          parts.push(line.slice(offset, offset + maxChars));
        }
      }

      for (const part of parts) {
        const candidate = current ? `${current}\n${part}` : part;
        if (candidate.length > maxChars && current) {
          sections.push(current);
          current = part;
        } else {
          current = candidate;
        }
      }
    }

    if (current) sections.push(current);
    return sections;
  }

  private async summarizeEntireCall(): Promise<void> {
    if (this.summaryInFlight) return;

    const transcript = this.transcriptBuffer.getFormattedTranscript(
      this.speakerAliases,
      this.speakerMerges
    );
    if (!transcript.trim()) {
      this.send({
        type: 'summary_status',
        status: 'error',
        message: 'There is no transcript to summarize.',
      });
      return;
    }

    this.summaryInFlight = true;
    const sections = this.splitTranscript(transcript);
    this.send({ type: 'summary_status', status: 'started', sections: sections.length });

    const timestamp = Date.now();
    const startTime = Date.now();
    const systemPrompt =
      'You create accurate, traceable call summaries. Do not invent facts, owners, deadlines, or decisions.';
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    try {
      let result: string;
      let loggedInput: string;
      const provider = this.providerForModel(this.analysisModel);
      const hasClient = Boolean(this.getLlmClients()[provider]);

      if (!hasClient && provider === 'openai') {
        await new Promise((resolve) => setTimeout(resolve, 500));
        result = `[Mock] Entire-call summary requested for ${transcript.length} transcript characters.`;
        loggedInput = transcript;
      } else {
        const sectionSummaries: string[] = [];

        if (sections.length > 1) {
          for (let index = 0; index < sections.length; index++) {
            const sectionPrompt = [
              `Summarize transcript section ${index + 1} of ${sections.length}.`,
              'Preserve speaker names, decisions, commitments, action items, deadlines, open questions, and important facts.',
              'Keep details that another model will need to produce the final call summary.',
              '',
              'TRANSCRIPT SECTION:',
              '---',
              sections[index],
              '---',
            ].join('\n');
            const completion = await this.completeAnalysis(systemPrompt, sectionPrompt, 3000);
            if (completion === 'mock') {
              sectionSummaries.push(`(Section ${index + 1} had no summary.)`);
            } else {
              sectionSummaries.push(completion.text || `(Section ${index + 1} had no summary.)`);
              promptTokens += completion.promptTokens;
              completionTokens += completion.completionTokens;
              totalTokens += completion.totalTokens;
            }
          }
        }

        const source =
          sections.length === 1
            ? transcript
            : sectionSummaries
                .map((summary, index) => `SECTION ${index + 1} SUMMARY:\n${summary}`)
                .join('\n\n');
        loggedInput = source;
        const notesBlock = this.userNotes.trim()
          ? `\nUSER NOTES (authoritative context):\n${this.userNotes.trim()}\n`
          : '';
        const finalPrompt = [
          'Create a comprehensive summary of the entire call using the source below.',
          notesBlock,
          'Use these headings:',
          '1. Executive Summary',
          '2. Topics Discussed',
          '3. Decisions Made',
          '4. Action Items (include owner and deadline only when explicitly stated)',
          '5. Open Questions',
          '6. Follow-up Agenda',
          '7. Notable Statements (include speaker attribution)',
          '',
          sections.length === 1 ? 'FULL TRANSCRIPT:' : 'SECTION SUMMARIES:',
          '---',
          source,
          '---',
        ].join('\n');
        const completion = await this.completeAnalysis(systemPrompt, finalPrompt, 6000);
        if (completion === 'mock') {
          result = '(no summary returned)';
        } else {
          result = completion.text || '(no summary returned)';
          promptTokens += completion.promptTokens;
          completionTokens += completion.completionTokens;
          totalTokens += completion.totalTokens;
        }
      }

      const logEntry = logLlmCall({
        sessionId: this.sessionId,
        mode: 'whole-call-summary',
        timestamp,
        model: this.analysisModel,
        systemPrompt,
        userPrompt: loggedInput,
        response: result,
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs: Date.now() - startTime,
      });

      this.analysisResults.push({ result, timestamp });
      this.send({ type: 'analysis', result, timestamp });
      this.send({ type: 'llm_log', entry: logEntry });
      this.send({ type: 'summary_status', status: 'complete', sections: sections.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[WS] ${this.sessionId} — entire-call summary error:`, message);
      this.send({ type: 'summary_status', status: 'error', message });
    } finally {
      this.summaryInFlight = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------
  private async saveSession(): Promise<void> {
    const sessionData = this.buildSessionPayload({ autosave: false, endedAt: Date.now() });
    const filePath = path.join(config.sessionDir, `${this.sessionId}.json`);

    try {
      fs.mkdirSync(config.sessionDir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2));
      console.log(`[Session] Saved: ${filePath}`);
      this.removeAutosaveArtifacts();
      this.send({ type: 'session_saved', sessionId: this.sessionId, filePath });
    } catch (err) {
      console.error('[Session] Failed to save:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  private send(msg: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async onDisconnect(): Promise<void> {
    if (!this.isSessionActive) return;

    this.stopAutosaveLoop();
    await this.persistAutosave({ disconnect: true });
    this.isSessionActive = false;

    if (this.reasoningTimer) {
      clearInterval(this.reasoningTimer);
      this.reasoningTimer = null;
    }
    if (this.diarTimer) {
      clearInterval(this.diarTimer);
      this.diarTimer = null;
    }
    await this.transcription.stop();
  }
}
