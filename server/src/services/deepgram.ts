// ---------------------------------------------------------------------------
// Deepgram streaming transcription service.
//
// Uses Listen v1 websocket streaming in @deepgram/sdk.
//
// Returns final transcripts with audio-time offsets so the diarization
// pipeline can match speaker labels back to transcript chunks.
//
// Falls back to a mock generator when DEEPGRAM_API_KEY is not set.
// ---------------------------------------------------------------------------

import { DeepgramClient } from '@deepgram/sdk';
import { config } from '../config';

export type TranscriptCallback = (chunk: {
  text: string;
  isFinal: boolean;
  timestamp: number;       // wall-clock ms when received
  audioStart: number | null; // seconds, relative to session start (null for partials/mock)
  audioEnd: number | null;
}) => void;

export type StatusCallback = (
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
) => void;

export class DeepgramService {
  private transcriber: Awaited<ReturnType<DeepgramClient['listen']['v1']['connect']>> | null = null;
  private client: DeepgramClient | null = null;
  private mockTimer: ReturnType<typeof setInterval> | null = null;
  private isReady = false;

  constructor() {
    if (!config.useMockDeepgram) {
      this.client = new DeepgramClient({ apiKey: config.deepgramApiKey });
    }
  }

  async start(
    onTranscript: TranscriptCallback,
    onStatus: StatusCallback
  ): Promise<void> {
    if (config.useMockDeepgram) {
      this.startMock(onTranscript, onStatus);
      return;
    }

    onStatus('connecting');

    this.transcriber = await this.client!.listen.v1.connect({
      Authorization: `token ${config.deepgramApiKey}`,
      model: 'nova-3',
      language: 'en',
      encoding: 'linear16',
      sample_rate: config.sampleRate,
      channels: 1,
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
    });

    this.transcriber.on('open', () => {
      console.log('[Deepgram] Session opened');
      onStatus('connected');
    });

    this.transcriber.on('message', (message: any) => {
      if (!message || message.type !== 'Results') return;
      const transcript: string = message.channel?.alternatives?.[0]?.transcript ?? '';
      if (!transcript) return;
      const isFinal = Boolean(message.is_final);
      const start = typeof message.start === 'number' ? message.start : null;
      const duration = typeof message.duration === 'number' ? message.duration : null;
      const end = start !== null && duration !== null ? start + duration : null;
      onTranscript({
        text: transcript,
        isFinal,
        timestamp: Date.now(),
        audioStart: start,
        audioEnd: end,
      });
      if (isFinal) {
        console.log(`[Deepgram] Final: "${transcript.slice(0, 80)}..."`);
      }
    });

    this.transcriber.on('error', (error: Error) => {
      console.error('[Deepgram] Error:', error.message);
      onStatus('error');
    });

    this.transcriber.on('close', (event) => {
      console.log(`[Deepgram] Closed: ${event.code} - ${event.reason}`);
      onStatus('disconnected');
    });

    try {
      console.log('[Deepgram] Connecting websocket...');
      this.transcriber.connect();
      await Promise.race([
        this.transcriber.waitForOpen(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Deepgram connect timed out after 8 seconds')), 8000)
        ),
      ]);
      this.isReady = true;
      console.log('[Deepgram] websocket open - ready');
    } catch (err) {
      console.error('[Deepgram] Failed to connect:', err);
      onStatus('error');
      try { this.transcriber?.close(); } catch { /* ignore */ }
      this.transcriber = null;
      throw err;
    }
  }

  // Forward raw PCM audio buffer to Deepgram.
  // Drops chunks that arrive before the websocket is open.
  sendAudio(data: Buffer): void {
    if (config.useMockDeepgram) return;
    if (!this.transcriber || !this.isReady) return;
    try {
      this.transcriber.sendMedia(data);
    } catch {
      console.warn('[Deepgram] sendAudio failed (socket may have closed)');
    }
  }

  async stop(): Promise<void> {
    this.isReady = false;
    if (this.mockTimer) {
      clearInterval(this.mockTimer);
      this.mockTimer = null;
    }
    if (this.transcriber) {
      try {
        this.transcriber.sendCloseStream({ type: 'CloseStream' });
        this.transcriber.close();
      } catch {
        // Ignore close errors
      }
      this.transcriber = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Mock mode: generates a generic two-speaker conversation. Useful for local
  // UI development without a Deepgram key.
  // ---------------------------------------------------------------------------
  private startMock(onTranscript: TranscriptCallback, onStatus: StatusCallback): void {
    console.log('[Deepgram] MOCK mode active — generating sample transcript');
    onStatus('connected');

    const mockLines = [
      "Hey, thanks for jumping on. Can you hear me okay?",
      "Yeah, loud and clear. How's your week going so far?",
      "Pretty good. I wanted to walk through the project timeline today.",
      "Sounds good. I have about thirty minutes blocked off.",
      "Perfect. So the first milestone we're targeting is the end of next week.",
      "Got it. What does the team need from me before then?",
      "Mostly sign-off on the design doc, and a yes on the budget.",
      "I can get you the design sign-off by Thursday. Budget I'll have to check with finance.",
      "That works. We can move the budget item to next week if needed.",
      "Cool. Any blockers I should know about right now?",
      "One thing — the API rate limits are tighter than we expected.",
      "Okay, let's add that as an open question for the next sync.",
    ];

    let lineIndex = 0;
    let audioCursor = 0;

    const sendNextLine = () => {
      if (lineIndex >= mockLines.length) {
        clearInterval(this.mockTimer!);
        this.mockTimer = null;
        return;
      }

      const text = mockLines[lineIndex];
      lineIndex++;

      // Partial first
      onTranscript({
        text: text.slice(0, Math.floor(text.length * 0.6)) + '...',
        isFinal: false,
        timestamp: Date.now(),
        audioStart: null,
        audioEnd: null,
      });

      setTimeout(() => {
        const segmentDuration = 4; // fake seconds per line
        onTranscript({
          text,
          isFinal: true,
          timestamp: Date.now(),
          audioStart: audioCursor,
          audioEnd: audioCursor + segmentDuration,
        });
        audioCursor += segmentDuration + 1; // +1s simulated gap
      }, 800);
    };

    setTimeout(() => {
      sendNextLine();
      this.mockTimer = setInterval(sendNextLine, 5000);
    }, 1500);
  }
}
