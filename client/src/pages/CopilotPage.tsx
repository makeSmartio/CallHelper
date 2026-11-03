import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { TranscriptPanel } from '../components/TranscriptPanel';
import { NotesPanel } from '../components/NotesPanel';
import { SpeakersPanel } from '../components/SpeakersPanel';
import { MicStatusBadge } from '../components/MicStatusBadge';
import { StatusBadge } from '../components/StatusBadge';
import { startAudioCapture, AudioCapture, wsClient } from '../lib/ws';
import {
  listAudioInputDevices,
  getStoredMicDeviceId,
  storeMicDeviceId,
  type AudioInputDevice,
} from '../lib/audioDevices';
import { AppState, TranscriptChunk, ServerMessage, LlmLogEntry } from '../lib/types';
import { applyMerge, applyUnmerge, canonicalLabel } from '../lib/speakers';
import {
  API_BASE,
  LOCAL_AUTOSAVE_SCHEMA,
  saveLocalSnapshot,
  loadLocalSnapshot,
  clearLocalSnapshot,
  mergeAutosaveFromServer,
  concatArrayBuffers,
  type LocalSessionSnapshot,
} from '../lib/sessionAutosave';

const SPEAKER_ALIASES_KEY = 'copilot_speaker_aliases';
const SPEAKER_MERGES_KEY = 'copilot_speaker_merges';
const NOTES_KEY = 'copilot_notes';
const DIARIZATION_ENABLED_KEY = 'copilot_diarization_enabled';

type ServiceReadiness = 'ready' | 'mock' | 'disabled' | 'error' | 'unknown';

interface HealthServices {
  asr: ServiceReadiness;
  openai: ServiceReadiness;
  diarization: ServiceReadiness;
}

function readinessToBadge(
  readiness: ServiceReadiness
): 'ready' | 'mock' | 'disconnected' | 'error' {
  if (readiness === 'ready') return 'ready';
  if (readiness === 'mock') return 'mock';
  if (readiness === 'error') return 'error';
  return 'disconnected';
}
const OPENAI_MODEL_KEY = 'copilot_openai_model';
const OPENAI_MODELS = [
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra — balanced' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol — highest quality' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna — fastest / lowest cost' },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini — legacy economical' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'grok-4.7', label: 'Grok 4.7' },
] as const;

function encodeWav(chunks: ArrayBuffer[]): Blob {
  const totalSamples = chunks.reduce((n, b) => n + b.byteLength / 2, 0);
  const dataBytes = totalSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (const chunk of chunks) {
    const src = new Uint8Array(chunk);
    new Uint8Array(buffer).set(src, offset);
    offset += src.byteLength;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

// ---------------------------------------------------------------------------
// Drag handle between resizable panels
// ---------------------------------------------------------------------------
function ResizeHandle({ axis }: { axis: 'x' | 'y' }) {
  const isX = axis === 'x';
  return (
    <PanelResizeHandle
      className={`group relative shrink-0 flex items-center justify-center outline-none ${
        isX ? 'w-3 cursor-col-resize' : 'h-3 cursor-row-resize'
      }`}
    >
      <div
        className={`rounded-full bg-gray-800 transition-colors group-hover:bg-emerald-700 group-data-[resize-handle-state=drag]:bg-emerald-600 ${
          isX ? 'h-10 w-1' : 'h-1 w-10'
        }`}
      />
    </PanelResizeHandle>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function CopilotPage() {
  const [appState, setAppState] = useState<AppState>('idle');
  const [wsConnected, setWsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState('');
  const audioUploadInputRef = useRef<HTMLInputElement>(null);
  const [mockMode, setMockMode] = useState({ deepgram: false, openai: false, diarization: false });
  const [serviceHealth, setServiceHealth] = useState<HealthServices>({
    asr: 'unknown',
    openai: 'unknown',
    diarization: 'unknown',
  });
  const [restoreOffer, setRestoreOffer] = useState<LocalSessionSnapshot | null>(null);
  const [deepgramStatus, setDeepgramStatus] = useState('disconnected');
  const [diarStatus, setDiarStatus] = useState<'disconnected' | 'idle' | 'running' | 'connected' | 'error'>('disconnected');
  const [diarizationEnabled, setDiarizationEnabled] = useState(() => {
    try {
      const raw = localStorage.getItem(DIARIZATION_ENABLED_KEY);
      if (raw === null) return true;
      return raw !== 'false';
    } catch {
      return true;
    }
  });
  const [numSpeakers, setNumSpeakers] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const [transcriptChunks, setTranscriptChunks] = useState<TranscriptChunk[]>([]);
  const [partialText, setPartialText] = useState<string | null>(null);
  const [speakerFilter, setSpeakerFilter] = useState<string | null>(null);

  const [prompt, setPrompt] = useState(
    "Summarize what has been said so far. Note any decisions, action items, or open questions."
  );
  const [savedPrompts, setSavedPrompts] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('copilot_saved_prompts');
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [analysisResults, setAnalysisResults] = useState<Array<{ result: string; timestamp: number }>>([]);
  const [llmLogEntries, setLlmLogEntries] = useState<LlmLogEntry[]>([]);
  const [logPaneOpen, setLogPaneOpen] = useState(false);
  const [expandedLogIds, setExpandedLogIds] = useState<Set<number>>(new Set());
  const [analysisWarning, setAnalysisWarning] = useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryMessage, setSummaryMessage] = useState<string | null>(null);
  const [openAiModel, setOpenAiModel] = useState(() => {
    try {
      const saved = localStorage.getItem(OPENAI_MODEL_KEY);
      return OPENAI_MODELS.some((model) => model.id === saved) ? saved! : 'gpt-5.6-terra';
    } catch {
      return 'gpt-5.6-terra';
    }
  });
  const [livePauseSecs, setLivePauseSecs] = useState<number | null>(null);
  // AI analysis is OFF by default — the user opts in via the Resume button
  // or fires single passes via Run Now.
  const [analysisPaused, setAnalysisPaused] = useState(true);

  const [speakerAliases, setSpeakerAliases] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem(SPEAKER_ALIASES_KEY);
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  });
  const [speakerMerges, setSpeakerMerges] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem(SPEAKER_MERGES_KEY);
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  });
  const [notes, setNotes] = useState<string>(() => {
    try {
      return localStorage.getItem(NOTES_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [micDevices, setMicDevices] = useState<AudioInputDevice[]>([]);
  const [selectedMicDeviceId, setSelectedMicDeviceId] = useState<string>(
    () => getStoredMicDeviceId() ?? ''
  );
  const [activeMicLabel, setActiveMicLabel] = useState<string | null>(null);

  const audioCaptureRef = useRef<AudioCapture | null>(null);
  const audioChunksRef = useRef<ArrayBuffer[]>([]);
  const startTimeoutRef = useRef<number | null>(null);
  const promptDebounceRef = useRef<number | null>(null);
  const analysisBottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const analysisWatchdogRef = useRef<number | null>(null);
  const firstTranscriptRef = useRef<boolean>(false);
  const lastSpeechAtRef = useRef<number>(0);
  const pauseCheckIntervalRef = useRef<number | null>(null);
  const pauseForcedRef = useRef<boolean>(false);
  const notesDebounceRef = useRef<number | null>(null);
  // Mirrors of the latest aliases / merges / notes so callbacks with stable
  // identity (e.g. handleServerMessage) can read current values without
  // re-binding.
  const speakerAliasesRef = useRef<Record<string, string>>(speakerAliases);
  const speakerMergesRef = useRef<Record<string, string>>(speakerMerges);
  const notesRef = useRef<string>(notes);
  const analysisPausedRef = useRef<boolean>(analysisPaused);
  const diarizationEnabledRef = useRef<boolean>(diarizationEnabled);

  useEffect(() => {
    speakerAliasesRef.current = speakerAliases;
  }, [speakerAliases]);
  useEffect(() => {
    speakerMergesRef.current = speakerMerges;
  }, [speakerMerges]);
  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);
  useEffect(() => {
    analysisPausedRef.current = analysisPaused;
  }, [analysisPaused]);
  useEffect(() => {
    diarizationEnabledRef.current = diarizationEnabled;
  }, [diarizationEnabled]);
  useEffect(() => {
    setSpeakerFilter((current) =>
      current ? canonicalLabel(current, speakerMerges) : null
    );
  }, [speakerMerges]);

  const refreshMicDevices = useCallback(async () => {
    try {
      const devices = await listAudioInputDevices();
      setMicDevices(devices);
      setSelectedMicDeviceId((current) => {
        if (current && devices.some((device) => device.deviceId === current)) {
          return current;
        }
        const stored = getStoredMicDeviceId();
        if (stored && devices.some((device) => device.deviceId === stored)) {
          return stored;
        }
        return devices[0]?.deviceId ?? '';
      });
    } catch {
      // ignore enumerate failures
    }
  }, []);

  useEffect(() => {
    void refreshMicDevices();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const onDeviceChange = () => {
      void refreshMicDevices();
    };
    mediaDevices.addEventListener('devicechange', onDeviceChange);
    return () => mediaDevices.removeEventListener('devicechange', onDeviceChange);
  }, [refreshMicDevices]);

  const refreshServiceHealth = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/health`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        mockMode?: { deepgram: boolean; openai: boolean; diarization: boolean };
        services?: {
          asr?: { status?: ServiceReadiness };
          openai?: { status?: ServiceReadiness };
          diarization?: { status?: ServiceReadiness };
        };
      };
      if (data.mockMode) {
        setMockMode(data.mockMode);
      }
      setServiceHealth({
        asr: data.services?.asr?.status ?? 'unknown',
        openai: data.services?.openai?.status ?? 'unknown',
        diarization: data.services?.diarization?.status ?? 'unknown',
      });
    } catch {
      setServiceHealth({
        asr: 'error',
        openai: 'error',
        diarization: 'error',
      });
    }
  }, []);

  useEffect(() => {
    void refreshServiceHealth();
    const interval = window.setInterval(() => {
      void refreshServiceHealth();
    }, 10000);
    return () => window.clearInterval(interval);
  }, [refreshServiceHealth]);

  const sendAudioChunk = useCallback((buffer: ArrayBuffer) => {
    audioChunksRef.current.push(buffer.slice(0));
    wsClient.sendAudio(buffer);
  }, []);

  const ensureMicLabels = useCallback(async () => {
    const needsPermission =
      micDevices.length === 0 ||
      micDevices.every((device) => device.label.startsWith('Microphone '));
    if (!needsPermission) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      await refreshMicDevices();
    } catch {
      // user denied or hardware unavailable
    }
  }, [micDevices, refreshMicDevices]);

  const autosaveStateRef = useRef({
    sessionId: null as string | null,
    appState: 'idle' as AppState,
    transcriptChunks: [] as TranscriptChunk[],
    partialText: null as string | null,
    prompt: '',
    analysisResults: [] as Array<{ result: string; timestamp: number }>,
    llmLogEntries: [] as LlmLogEntry[],
    speakerAliases: {} as Record<string, string>,
    speakerMerges: {} as Record<string, string>,
    notes: '',
    analysisPaused: true,
    mockMode: { deepgram: false, openai: false, diarization: false },
  });

  useEffect(() => {
    autosaveStateRef.current = {
      sessionId,
      appState,
      transcriptChunks,
      partialText,
      prompt,
      analysisResults,
      llmLogEntries,
      speakerAliases,
      speakerMerges,
      notes,
      analysisPaused,
      mockMode,
    };
  }, [
    sessionId,
    appState,
    transcriptChunks,
    partialText,
    prompt,
    analysisResults,
    llmLogEntries,
    speakerAliases,
    speakerMerges,
    notes,
    analysisPaused,
    mockMode,
  ]);

  const flushLocalSnapshot = useCallback(async () => {
    const s = autosaveStateRef.current;
    if (s.appState !== 'listening' && s.appState !== 'stopping') return;
    let audioPcm: ArrayBuffer | undefined;
    try {
      if (audioChunksRef.current.length > 0) {
        audioPcm = concatArrayBuffers(audioChunksRef.current);
      }
    } catch {
      audioPcm = undefined;
    }
    await saveLocalSnapshot({
      schemaVersion: LOCAL_AUTOSAVE_SCHEMA,
      updatedAt: Date.now(),
      sessionId: s.sessionId,
      wasListening: s.appState === 'listening' || s.appState === 'stopping',
      transcriptChunks: s.transcriptChunks,
      partialText: s.partialText,
      prompt: s.prompt,
      analysisResults: s.analysisResults,
      llmLogEntries: s.llmLogEntries,
      speakerAliases: s.speakerAliases,
      speakerMerges: s.speakerMerges,
      notes: s.notes,
      analysisPaused: s.analysisPaused,
      mockMode: s.mockMode,
      audioPcm,
    });
  }, []);

  const flushRef = useRef<() => void>(() => {});
  useEffect(() => {
    flushRef.current = () => {
      void flushLocalSnapshot();
    };
  }, [flushLocalSnapshot]);

  useEffect(() => {
    if (appState !== 'listening' && appState !== 'stopping') return;
    const id = window.setInterval(() => flushRef.current(), 15000);
    return () => window.clearInterval(id);
  }, [appState]);

  useEffect(() => {
    const onHide = () => flushRef.current();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  const transcriptAutosaveDebounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (appState !== 'listening') return;
    if (transcriptAutosaveDebounceRef.current !== null) {
      window.clearTimeout(transcriptAutosaveDebounceRef.current);
    }
    transcriptAutosaveDebounceRef.current = window.setTimeout(() => {
      flushRef.current();
    }, 2500);
    return () => {
      if (transcriptAutosaveDebounceRef.current !== null) {
        window.clearTimeout(transcriptAutosaveDebounceRef.current);
        transcriptAutosaveDebounceRef.current = null;
      }
    };
  }, [transcriptChunks, appState]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const snap = await loadLocalSnapshot();
      if (cancelled || !snap) return;
      if (snap.schemaVersion !== LOCAL_AUTOSAVE_SCHEMA) return;
      const hasPayload =
        snap.transcriptChunks.length > 0 ||
        snap.analysisResults.length > 0 ||
        (snap.audioPcm !== undefined && snap.audioPcm.byteLength > 0);
      if (!hasPayload) return;
      let merged = snap;
      if (snap.sessionId) {
        merged = await mergeAutosaveFromServer(snap.sessionId, snap);
      }
      if (cancelled) return;
      setRestoreOffer(merged);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyRestore = useCallback((snap: LocalSessionSnapshot) => {
    setTranscriptChunks(snap.transcriptChunks);
    setPartialText(snap.partialText);
    setSpeakerFilter(null);
    setPrompt(snap.prompt);
    setAnalysisResults(snap.analysisResults);
    setLlmLogEntries(snap.llmLogEntries);
    if (snap.llmLogEntries.length > 0) {
      setLogPaneOpen(true);
    }
    setSpeakerAliases(snap.speakerAliases);
    setSpeakerMerges(snap.speakerMerges);
    setNotes(snap.notes);
    try {
      localStorage.setItem(SPEAKER_ALIASES_KEY, JSON.stringify(snap.speakerAliases));
      localStorage.setItem(SPEAKER_MERGES_KEY, JSON.stringify(snap.speakerMerges));
      localStorage.setItem(NOTES_KEY, snap.notes);
    } catch {
      /* ignore */
    }
    setAnalysisPaused(snap.analysisPaused);
    setMockMode(snap.mockMode);
    setSessionId(snap.sessionId);
    if (snap.audioPcm !== undefined && snap.audioPcm.byteLength > 0) {
      audioChunksRef.current = [snap.audioPcm.slice(0)];
    } else {
      audioChunksRef.current = [];
    }
    if (wsClient.isConnected) {
      wsClient.sendJSON({
        type: 'load_transcript',
        transcriptChunks: snap.transcriptChunks,
      });
      wsClient.sendJSON({ type: 'set_prompt', prompt: snap.prompt });
      wsClient.sendJSON({ type: 'set_speaker_aliases', aliases: snap.speakerAliases });
      wsClient.sendJSON({ type: 'set_speaker_merges', merges: snap.speakerMerges });
      wsClient.sendJSON({ type: 'set_notes', notes: snap.notes });
      wsClient.sendJSON({ type: 'set_analysis_paused', paused: snap.analysisPaused });
    }
    setRestoreOffer(null);
    setError(null);
  }, []);

  useEffect(() => {
    analysisBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [analysisResults]);

  // Silence-detection ticker — forces an analysis run after PAUSE_THRESHOLD_SECS
  // of silence, so the assistant catches up at natural breaks in the conversation.
  const PAUSE_THRESHOLD_SECS = 3;
  useEffect(() => {
    if (appState === 'listening') {
      lastSpeechAtRef.current = 0;
      pauseForcedRef.current = false;
      pauseCheckIntervalRef.current = window.setInterval(() => {
        if (lastSpeechAtRef.current === 0) return;
        const secs = Math.floor((Date.now() - lastSpeechAtRef.current) / 1000);
        if (secs >= PAUSE_THRESHOLD_SECS) {
          setLivePauseSecs(secs);
          if (!pauseForcedRef.current) {
            pauseForcedRef.current = true;
            wsClient.sendJSON({ type: 'force_analysis', source: 'silence' });
          }
        } else {
          setLivePauseSecs(null);
        }
      }, 1000);
    } else {
      if (pauseCheckIntervalRef.current !== null) {
        window.clearInterval(pauseCheckIntervalRef.current);
        pauseCheckIntervalRef.current = null;
      }
      setLivePauseSecs(null);
    }
    return () => {
      if (pauseCheckIntervalRef.current !== null) {
        window.clearInterval(pauseCheckIntervalRef.current);
        pauseCheckIntervalRef.current = null;
      }
    };
  }, [appState]);

  const handleServerMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'session_started':
        if (startTimeoutRef.current !== null) {
          window.clearTimeout(startTimeoutRef.current);
          startTimeoutRef.current = null;
        }
        setSessionId(msg.sessionId);
        setMockMode(msg.mockMode);
        setAppState('listening');
        setError(null);
        setDiarStatus(
          msg.mockMode.diarization || !diarizationEnabledRef.current
            ? 'disconnected'
            : 'idle'
        );
        // Re-sync persisted aliases / merges / notes / pause-state to the
        // fresh server session so the server matches the user's preferences.
        if (wsClient.isConnected) {
          wsClient.sendJSON({
            type: 'set_speaker_aliases',
            aliases: speakerAliasesRef.current,
          });
          wsClient.sendJSON({
            type: 'set_speaker_merges',
            merges: speakerMergesRef.current,
          });
          wsClient.sendJSON({ type: 'set_notes', notes: notesRef.current });
          wsClient.sendJSON({
            type: 'set_analysis_paused',
            paused: analysisPausedRef.current,
          });
          wsClient.sendJSON({
            type: 'set_diarization_enabled',
            enabled: diarizationEnabledRef.current,
          });
        }
        break;

      case 'transcript':
        if (msg.isFinal) {
          const now = Date.now();
          const gapMs = lastSpeechAtRef.current > 0 ? now - lastSpeechAtRef.current : 0;
          const pauseSecs = Math.floor(gapMs / 1000);
          setTranscriptChunks((prev) => {
            const pauseMarkers: TranscriptChunk[] =
              pauseSecs >= PAUSE_THRESHOLD_SECS
                ? [
                    {
                      id: -lastSpeechAtRef.current, // distinct negative id for pause markers
                      text: `⏸  Pause: ${pauseSecs}s`,
                      isFinal: true,
                      timestamp: lastSpeechAtRef.current,
                      speaker: null,
                    },
                  ]
                : [];
            return [
              ...prev,
              ...pauseMarkers,
              {
                id: msg.id ?? 0,
                text: msg.text,
                isFinal: true,
                timestamp: msg.timestamp,
                speaker: msg.speaker,
              },
            ];
          });
          lastSpeechAtRef.current = now;
          pauseForcedRef.current = false;
          setLivePauseSecs(null);
          setPartialText(null);
          if (!firstTranscriptRef.current) {
            firstTranscriptRef.current = true;
            analysisWatchdogRef.current = window.setTimeout(() => {
              setAnalysisWarning(
                'No analysis response received yet. Check that an OpenAI key is set and the prompt is not empty.'
              );
            }, 20_000);
          }
        } else {
          setPartialText(msg.text);
        }
        break;

      case 'diarization_update': {
        setNumSpeakers(msg.numSpeakers);
        setTranscriptChunks((prev) => {
          if (msg.updates.length === 0) return prev;
          const byId = new Map(msg.updates.map((u) => [u.id, u.speaker]));
          let mutated = false;
          const next = prev.map((c) => {
            if (byId.has(c.id)) {
              mutated = true;
              return { ...c, speaker: byId.get(c.id) ?? c.speaker };
            }
            return c;
          });
          return mutated ? next : prev;
        });
        break;
      }

      case 'status':
        if (msg.service === 'deepgram') setDeepgramStatus(msg.status);
        if (msg.service === 'diarization') {
          setDiarStatus(msg.status as typeof diarStatus);
        }
        break;

      case 'analysis':
        setAnalysisResults((prev) => [...prev, { result: msg.result, timestamp: msg.timestamp }]);
        if (analysisWatchdogRef.current !== null) {
          window.clearTimeout(analysisWatchdogRef.current);
          analysisWatchdogRef.current = null;
        }
        setAnalysisWarning(null);
        break;

      case 'summary_status':
        if (msg.status === 'started') {
          setIsSummarizing(true);
          setSummaryMessage(
            `Summarizing the entire call in ${msg.sections ?? 1} section${
              msg.sections === 1 ? '' : 's'
            }…`
          );
        } else if (msg.status === 'complete') {
          setIsSummarizing(false);
          setSummaryMessage('Entire-call summary complete.');
        } else {
          setIsSummarizing(false);
          setSummaryMessage(null);
          setError(`Summary failed: ${msg.message ?? 'Unknown error'}`);
        }
        break;

      case 'llm_log':
        setLlmLogEntries((prev) => [...prev, msg.entry]);
        setLogPaneOpen(true);
        break;

      case 'error':
        setError(`${msg.code}: ${msg.message}`);
        if (msg.code === 'TRANSCRIPTION_CONNECT_FAILED' || msg.code === 'MIC_DENIED') {
          setAppState('idle');
          audioCaptureRef.current?.stop();
          audioCaptureRef.current = null;
        }
        break;

      case 'session_saved':
        void clearLocalSnapshot();
        setAppState('idle');
        break;
    }
  }, []);

  useEffect(() => {
    const removeState = wsClient.onStateChange((connected) => {
      setWsConnected(connected);
      if (connected) {
        setError((current) =>
          current === 'Connection to backend lost. Refresh to reconnect.' ||
          current === 'Could not connect to backend. Is the server running?' ||
          current?.startsWith('Could not open the live WebSocket')
            ? null
            : current
        );
      } else {
        setAppState('idle');
        setError('Connection to backend lost. Refresh to reconnect.');
      }
    });
    const removeMsg = wsClient.onMessage(handleServerMessage);

    wsClient
      .connect()
      .then(() => {
        setWsConnected(true);
        setError(null);
      })
      .catch(() => {
        window.setTimeout(() => {
          if (!wsClient.isConnected) {
            setError(
              'Could not open the live WebSocket. The HTTP API is reachable; retrying the socket…'
            );
          }
        }, 1500);
      });

    return () => {
      removeState();
      removeMsg();
    };
  }, [handleServerMessage]);

  const handlePromptChange = useCallback((value: string) => {
    setPrompt(value);
    if (promptDebounceRef.current !== null) window.clearTimeout(promptDebounceRef.current);
    promptDebounceRef.current = window.setTimeout(() => {
      if (wsClient.isConnected) {
        wsClient.sendJSON({ type: 'set_prompt', prompt: value });
      }
    }, 500);
  }, []);

  const handleStart = useCallback(async () => {
    if (appState !== 'idle') return;
    setRestoreOffer(null);
    void clearLocalSnapshot();
    setAppState('starting');
    setError(null);
    setAnalysisWarning(null);
    audioChunksRef.current = [];
    firstTranscriptRef.current = false;
    if (analysisWatchdogRef.current !== null) {
      window.clearTimeout(analysisWatchdogRef.current);
      analysisWatchdogRef.current = null;
    }

    let capture: AudioCapture;
    try {
      capture = await startAudioCapture(
        sendAudioChunk,
        selectedMicDeviceId ? { deviceId: selectedMicDeviceId } : undefined
      );
      setSelectedMicDeviceId(capture.deviceId);
      storeMicDeviceId(capture.deviceId);
      setActiveMicLabel(capture.deviceLabel);
      void refreshMicDevices();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(
        msg.includes('Permission denied') || msg.includes('NotAllowedError')
          ? 'Microphone access denied. Please allow microphone access and try again.'
          : `Microphone error: ${msg}`
      );
      setAppState('idle');
      return;
    }

    audioCaptureRef.current = capture;

    if (!wsClient.isConnected) {
      capture.stop();
      audioCaptureRef.current = null;
      setActiveMicLabel(null);
      setAppState('idle');
      setError('WebSocket disconnected while waiting for mic permission. Please try again.');
      return;
    }

    wsClient.sendJSON({ type: 'set_model', model: openAiModel });
    wsClient.sendJSON({ type: 'set_prompt', prompt });
    wsClient.sendJSON({
      type: 'set_diarization_enabled',
      enabled: diarizationEnabledRef.current,
    });
    wsClient.sendJSON({ type: 'start_session' });

    const id = window.setTimeout(() => {
      setAppState((current) => {
        if (current === 'starting') {
          audioCaptureRef.current?.stop();
          audioCaptureRef.current = null;
          setActiveMicLabel(null);
          setError('Session start timed out. Check that the backend is running.');
          return 'idle';
        }
        return current;
      });
    }, 10_000);
    startTimeoutRef.current = id;
  }, [appState, openAiModel, prompt, refreshMicDevices, selectedMicDeviceId, sendAudioChunk]);

  const handleMicChange = useCallback(
    async (deviceId: string) => {
      if (!deviceId) return;

      const previousDeviceId =
        audioCaptureRef.current?.deviceId || selectedMicDeviceId || null;

      setSelectedMicDeviceId(deviceId);
      storeMicDeviceId(deviceId);

      if (appState !== 'listening') return;

      audioCaptureRef.current?.stop();
      audioCaptureRef.current = null;

      try {
        const capture = await startAudioCapture(sendAudioChunk, { deviceId });
        audioCaptureRef.current = capture;
        setSelectedMicDeviceId(capture.deviceId);
        storeMicDeviceId(capture.deviceId);
        setActiveMicLabel(capture.deviceLabel);
        void refreshMicDevices();
        setError(null);
      } catch (err) {
        if (previousDeviceId) {
          try {
            const capture = await startAudioCapture(sendAudioChunk, {
              deviceId: previousDeviceId,
            });
            audioCaptureRef.current = capture;
            setSelectedMicDeviceId(capture.deviceId);
            storeMicDeviceId(capture.deviceId);
            setActiveMicLabel(capture.deviceLabel);
            setError('Could not switch microphone. Reverted to the previous device.');
            return;
          } catch {
            // fall through
          }
        }

        const msg = err instanceof Error ? err.message : String(err);
        setActiveMicLabel(null);
        setError(
          msg.includes('Permission denied') || msg.includes('NotAllowedError')
            ? 'Microphone access lost. Stop the session and try again.'
            : `Microphone switch failed: ${msg}`
        );
      }
    },
    [appState, refreshMicDevices, selectedMicDeviceId, sendAudioChunk]
  );

  const handleStop = useCallback(() => {
    if (appState !== 'listening') return;
    setAppState('stopping');
    setAnalysisPaused(true);
    audioCaptureRef.current?.stop();
    audioCaptureRef.current = null;
    setActiveMicLabel(null);
    wsClient.sendJSON({ type: 'stop_session' });
    if (analysisWatchdogRef.current !== null) {
      window.clearTimeout(analysisWatchdogRef.current);
      analysisWatchdogRef.current = null;
    }
    firstTranscriptRef.current = false;
  }, [appState]);

  const handleExport = useCallback(() => {
    const stamp = sessionId?.slice(0, 8) ?? String(Date.now());

    if (
      transcriptChunks.length > 0 ||
      analysisResults.length > 0 ||
      llmLogEntries.length > 0
    ) {
      const payload = {
        version: 4,
        exportedAt: new Date().toISOString(),
        sessionId,
        prompt,
        analysisModel: openAiModel,
        transcriptChunks,
        analysisResults,
        llmLogEntries,
        speakerAliases,
        speakerMerges,
        notes,
      };
      const jsonBlob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      });
      const jsonUrl = URL.createObjectURL(jsonBlob);
      const jsonLink = document.createElement('a');
      jsonLink.href = jsonUrl;
      jsonLink.download = `call-session-${stamp}.json`;
      jsonLink.click();
      URL.revokeObjectURL(jsonUrl);
    }

    if (audioChunksRef.current.length > 0) {
      const wavBlob = encodeWav(audioChunksRef.current);
      const wavUrl = URL.createObjectURL(wavBlob);
      const wavLink = document.createElement('a');
      wavLink.href = wavUrl;
      wavLink.download = `call-${stamp}.wav`;
      wavLink.click();
      URL.revokeObjectURL(wavUrl);
    }
  }, [
    sessionId,
    prompt,
    openAiModel,
    transcriptChunks,
    analysisResults,
    llmLogEntries,
    speakerAliases,
    speakerMerges,
    notes,
  ]);

  const handleClear = useCallback(() => {
    void clearLocalSnapshot();
    setTranscriptChunks([]);
    setPartialText(null);
    setSpeakerFilter(null);
    setAnalysisResults([]);
    setLlmLogEntries([]);
    setExpandedLogIds(new Set());
    setSessionId(null);
    setError(null);
    setAnalysisWarning(null);
    setIsSummarizing(false);
    setSummaryMessage(null);
    setDeepgramStatus('disconnected');
    setDiarStatus('disconnected');
    setNumSpeakers(0);
    setAnalysisPaused(true);
    setActiveMicLabel(null);
    audioChunksRef.current = [];
    firstTranscriptRef.current = false;
    lastSpeechAtRef.current = 0;
    pauseForcedRef.current = false;
    if (analysisWatchdogRef.current !== null) {
      window.clearTimeout(analysisWatchdogRef.current);
      analysisWatchdogRef.current = null;
    }
  }, []);

  const handleUploadAudio = useCallback(() => {
    audioUploadInputRef.current?.click();
  }, []);

  const handleAudioFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadMessage('Transcribing & Diarizing Audio File (this may take a minute)...');
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/sessions/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Server returned status ${res.status}`);
      }

      const sessionData = await res.json();

      const snap: LocalSessionSnapshot = {
        schemaVersion: 1,
        updatedAt: Date.now(),
        sessionId: sessionData.sessionId,
        wasListening: false,
        transcriptChunks: sessionData.transcriptChunks || [],
        partialText: null,
        prompt: sessionData.customPrompt || 'Summarize what has been said so far. Note any decisions, action items, or open questions.',
        analysisResults: sessionData.analysisResults || [],
        llmLogEntries: sessionData.llmLogEntries || [],
        speakerAliases: sessionData.speakerAliases || {},
        speakerMerges: sessionData.speakerMerges || {},
        notes: sessionData.notes || '',
        analysisPaused: true,
        mockMode: { deepgram: false, openai: false, diarization: false }
      };

      applyRestore(snap);
      setIsUploading(false);
      setUploadMessage('');
    } catch (err) {
      setIsUploading(false);
      setUploadMessage('');
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Audio upload failed: ${msg}`);
      console.error(err);
    } finally {
      e.target.value = '';
    }
  }, [applyRestore]);

  const handleImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const raw = ev.target?.result as string;
        const data = JSON.parse(raw);

        if (
          data.version !== 1 &&
          data.version !== 2 &&
          data.version !== 3 &&
          data.version !== 4
        ) {
          setError(`Import failed: unrecognized version "${data.version}"`);
          return;
        }

        if (data.prompt !== undefined) {
          setPrompt(data.prompt);
          if (wsClient.isConnected) {
            wsClient.sendJSON({ type: 'set_prompt', prompt: data.prompt });
          }
        }
        if (
          typeof data.analysisModel === 'string' &&
          OPENAI_MODELS.some((model) => model.id === data.analysisModel)
        ) {
          setOpenAiModel(data.analysisModel);
          try {
            localStorage.setItem(OPENAI_MODEL_KEY, data.analysisModel);
          } catch {
            // ignore
          }
          if (wsClient.isConnected) {
            wsClient.sendJSON({ type: 'set_model', model: data.analysisModel });
          }
        }
        if (Array.isArray(data.transcriptChunks)) {
          // v1 chunks didn't have id or speaker — backfill those.
          const importedChunks = data.transcriptChunks.map(
            (c: TranscriptChunk, idx: number) => ({
              id: c.id ?? idx + 1,
              text: c.text,
              isFinal: c.isFinal ?? true,
              timestamp: c.timestamp,
              speaker: c.speaker ?? null,
            })
          );
          setTranscriptChunks(importedChunks);
          setSpeakerFilter(null);
          if (wsClient.isConnected) {
            wsClient.sendJSON({
              type: 'load_transcript',
              transcriptChunks: importedChunks,
            });
          }
        }
        if (Array.isArray(data.analysisResults)) setAnalysisResults(data.analysisResults);
        if (Array.isArray(data.llmLogEntries)) {
          setLlmLogEntries(data.llmLogEntries);
          if (data.llmLogEntries.length > 0) setLogPaneOpen(true);
        }
        if (data.sessionId) setSessionId(data.sessionId);
        if (data.speakerAliases && typeof data.speakerAliases === 'object') {
          const aliases = data.speakerAliases as Record<string, string>;
          setSpeakerAliases(aliases);
          try {
            localStorage.setItem(SPEAKER_ALIASES_KEY, JSON.stringify(aliases));
          } catch {
            // ignore
          }
          if (wsClient.isConnected) {
            wsClient.sendJSON({ type: 'set_speaker_aliases', aliases });
          }
        }
        if (data.speakerMerges && typeof data.speakerMerges === 'object') {
          const merges = data.speakerMerges as Record<string, string>;
          setSpeakerMerges(merges);
          try {
            localStorage.setItem(SPEAKER_MERGES_KEY, JSON.stringify(merges));
          } catch {
            // ignore
          }
          if (wsClient.isConnected) {
            wsClient.sendJSON({ type: 'set_speaker_merges', merges });
          }
        }
        if (typeof data.notes === 'string') {
          setNotes(data.notes);
          try {
            localStorage.setItem(NOTES_KEY, data.notes);
          } catch {
            // ignore
          }
          if (wsClient.isConnected) {
            wsClient.sendJSON({ type: 'set_notes', notes: data.notes });
          }
        }
        setError(null);
      } catch {
        setError('Import failed: file is not valid JSON');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, []);

  const handleSavePrompt = useCallback(() => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setSavedPrompts((prev) => {
      if (prev.includes(trimmed)) return prev;
      const next = [trimmed, ...prev];
      localStorage.setItem('copilot_saved_prompts', JSON.stringify(next));
      return next;
    });
  }, [prompt]);

  const handleDeletePrompt = useCallback((idx: number) => {
    setSavedPrompts((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      localStorage.setItem('copilot_saved_prompts', JSON.stringify(next));
      return next;
    });
  }, []);

  const handleSelectSavedPrompt = useCallback((p: string) => {
    setPrompt(p);
    if (wsClient.isConnected) {
      wsClient.sendJSON({ type: 'set_prompt', prompt: p });
    }
  }, []);

  // Aliases are keyed by the CANONICAL speaker label (the post-merge identity).
  // Callers from the transcript chips and the speakers panel pass canonical
  // labels directly. Pass an empty string to remove an alias.
  const handleRenameSpeaker = useCallback((canonLabel: string, newName: string) => {
    setSpeakerAliases((prev) => {
      const next = { ...prev };
      const trimmed = newName.trim();
      if (trimmed.length === 0) {
        delete next[canonLabel];
      } else {
        next[canonLabel] = trimmed;
      }
      try {
        localStorage.setItem(SPEAKER_ALIASES_KEY, JSON.stringify(next));
      } catch {
        // ignore quota / private-mode failures
      }
      if (wsClient.isConnected) {
        wsClient.sendJSON({ type: 'set_speaker_aliases', aliases: next });
      }
      return next;
    });
  }, []);

  const persistMerges = useCallback((next: Record<string, string>) => {
    try {
      localStorage.setItem(SPEAKER_MERGES_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
    if (wsClient.isConnected) {
      wsClient.sendJSON({ type: 'set_speaker_merges', merges: next });
    }
  }, []);

  const handleMergeSpeaker = useCallback(
    (source: string, target: string) => {
      setSpeakerMerges((prev) => {
        const next = applyMerge(prev, source, target);
        if (next === prev) return prev;
        persistMerges(next);
        return next;
      });
      // If the source had its own alias, drop it — the merged identity uses
      // the target's alias going forward. (We don't auto-copy the source's
      // alias onto the target so we don't accidentally overwrite an intentional
      // name the user already set.)
      setSpeakerAliases((prev) => {
        if (!(source in prev)) return prev;
        const next = { ...prev };
        delete next[source];
        try {
          localStorage.setItem(SPEAKER_ALIASES_KEY, JSON.stringify(next));
        } catch {
          // ignore
        }
        if (wsClient.isConnected) {
          wsClient.sendJSON({ type: 'set_speaker_aliases', aliases: next });
        }
        return next;
      });
    },
    [persistMerges]
  );

  const handleUnmergeSpeaker = useCallback(
    (source: string) => {
      setSpeakerMerges((prev) => {
        const next = applyUnmerge(prev, source);
        if (next === prev) return prev;
        persistMerges(next);
        return next;
      });
    },
    [persistMerges]
  );

  const handleNotesChange = useCallback((value: string) => {
    setNotes(value);
    try {
      localStorage.setItem(NOTES_KEY, value);
    } catch {
      // ignore quota / private-mode failures
    }
    if (notesDebounceRef.current !== null) {
      window.clearTimeout(notesDebounceRef.current);
    }
    notesDebounceRef.current = window.setTimeout(() => {
      if (wsClient.isConnected) {
        wsClient.sendJSON({ type: 'set_notes', notes: value });
      }
    }, 500);
  }, []);

  const handleRunNow = useCallback(() => {
    if (wsClient.isConnected) {
      if (appState !== 'listening') {
        wsClient.sendJSON({ type: 'load_transcript', transcriptChunks });
        wsClient.sendJSON({ type: 'set_prompt', prompt });
      }
      wsClient.sendJSON({ type: 'set_model', model: openAiModel });
      wsClient.sendJSON({ type: 'force_analysis', source: 'user' });
    }
  }, [appState, openAiModel, prompt, transcriptChunks]);

  const handleModelChange = useCallback((model: string) => {
    setOpenAiModel(model);
    try {
      localStorage.setItem(OPENAI_MODEL_KEY, model);
    } catch {
      // ignore
    }
    if (wsClient.isConnected) {
      wsClient.sendJSON({ type: 'set_model', model });
    }
  }, []);

  const handleSummarizeEntireCall = useCallback(() => {
    if (!wsClient.isConnected || transcriptChunks.length === 0 || isSummarizing) return;
    setError(null);
    setSummaryMessage('Preparing entire-call summary…');
    if (appState !== 'listening') {
      wsClient.sendJSON({ type: 'load_transcript', transcriptChunks });
    }
    wsClient.sendJSON({ type: 'set_model', model: openAiModel });
    wsClient.sendJSON({ type: 'summarize_call' });
  }, [appState, isSummarizing, openAiModel, transcriptChunks]);

  const handleToggleAnalysisPause = useCallback(() => {
    if (appState !== 'listening') return;
    setAnalysisPaused((p) => {
      const next = !p;
      wsClient.sendJSON({ type: 'set_analysis_paused', paused: next });
      return next;
    });
  }, [appState]);

  const handleToggleDiarization = useCallback(() => {
    setDiarizationEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(DIARIZATION_ENABLED_KEY, String(next));
      } catch {
        // ignore
      }
      if (wsClient.isConnected) {
        wsClient.sendJSON({ type: 'set_diarization_enabled', enabled: next });
      }
      if (!next) {
        setDiarStatus('disconnected');
      } else if (appState === 'listening') {
        setDiarStatus('idle');
      }
      return next;
    });
  }, [appState]);

  const toggleLogEntry = useCallback((idx: number) => {
    setExpandedLogIds((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const isListening = appState === 'listening';
  const isBusy =
    appState === 'starting' || appState === 'stopping' || isUploading || isSummarizing;
  const hasAudio = audioChunksRef.current.length > 0;
  const hasData =
    transcriptChunks.length > 0 || analysisResults.length > 0 || llmLogEntries.length > 0;

  // Unique raw speaker labels seen in the current transcript, in first-
  // appearance order. Feeds the SpeakersPanel directly.
  const knownRawSpeakers = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const c of transcriptChunks) {
      if (c.speaker && !seen.has(c.speaker)) {
        seen.add(c.speaker);
        ordered.push(c.speaker);
      }
    }
    return ordered;
  }, [transcriptChunks]);

  const visibleTranscriptChunks = useMemo(() => {
    if (!speakerFilter) return transcriptChunks;
    return transcriptChunks.filter(
      (chunk) =>
        chunk.speaker !== null &&
        canonicalLabel(chunk.speaker, speakerMerges) === speakerFilter
    );
  }, [speakerFilter, speakerMerges, transcriptChunks]);

  const diarServerAvailable =
    !mockMode.diarization && serviceHealth.diarization !== 'disabled';

  const diarBadgeStatus =
    !diarizationEnabled
      ? 'off'
      : isListening || appState === 'starting' || appState === 'stopping'
      ? mockMode.diarization
        ? 'disconnected'
        : diarStatus === 'running'
        ? 'connecting'
        : diarStatus === 'idle' || diarStatus === 'connected'
        ? 'connected'
        : diarStatus === 'error'
        ? 'error'
        : 'disconnected'
      : readinessToBadge(serviceHealth.diarization);

  const asrBadgeStatus =
    isListening || appState === 'starting' || appState === 'stopping'
      ? mockMode.deepgram
        ? 'mock'
        : deepgramStatus === 'connected'
        ? 'connected'
        : deepgramStatus === 'connecting'
        ? 'connecting'
        : deepgramStatus === 'error'
        ? 'error'
        : 'disconnected'
      : readinessToBadge(serviceHealth.asr);

  const aiBadgeStatus =
    isListening || appState === 'starting' || appState === 'stopping'
      ? mockMode.openai
        ? 'mock'
        : isListening && analysisPaused
        ? 'paused'
        : isListening
        ? 'connected'
        : readinessToBadge(serviceHealth.openai)
      : readinessToBadge(serviceHealth.openai);

  const micBadgeStatus =
    isListening
      ? 'connected'
      : appState === 'starting'
      ? 'connecting'
      : micDevices.length > 0
      ? 'ready'
      : 'disconnected';

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-gray-950">
      <header className="bg-gray-900 border-b border-gray-700 px-5 py-3 flex flex-col gap-2">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2 mr-2">
            <span className="text-lg font-bold text-white tracking-tight">Call Copilot</span>
            <span className="text-xs text-gray-500 font-mono bg-gray-800 px-1.5 py-0.5 rounded">
              v1
            </span>
          </div>

          <div className="flex items-center gap-2">
            <StatusBadge label="WS" status={wsConnected ? 'connected' : 'disconnected'} />
            <MicStatusBadge
              status={micBadgeStatus}
              devices={micDevices}
              selectedDeviceId={selectedMicDeviceId}
              activeDeviceLabel={activeMicLabel}
              onDeviceChange={handleMicChange}
              onDropdownFocus={() => {
                void ensureMicLabels();
              }}
              disabled={appState === 'starting' || appState === 'stopping'}
            />
            <StatusBadge label="ASR" status={asrBadgeStatus} />
            <StatusBadge
              label="Diar"
              status={diarBadgeStatus}
              onClick={handleToggleDiarization}
              title={
                !diarServerAvailable
                  ? diarizationEnabled
                    ? 'Diarization unavailable — configure DIARIZATION_URL in server/.env'
                    : 'Click to prefer diarization on (sidecar still needs DIARIZATION_URL)'
                  : diarizationEnabled
                  ? 'Click to turn off speaker diarization'
                  : 'Click to turn on speaker diarization'
              }
            />
            <StatusBadge label="AI" status={aiBadgeStatus} />
          </div>

          {numSpeakers > 0 && (
            <span className="text-xs text-gray-400 bg-gray-800 px-2 py-0.5 rounded">
              {numSpeakers} speaker{numSpeakers === 1 ? '' : 's'} detected
            </span>
          )}

          {sessionId && (
            <span className="text-xs text-gray-600 font-mono hidden lg:block">
              session: {sessionId.slice(0, 8)}…
            </span>
          )}

          <div className="flex-1" />

          <div className="flex items-center gap-2">
            <button
              onClick={handleStart}
              disabled={isListening || isBusy || !wsConnected}
              title={
                !wsConnected
                  ? 'Start needs a live WebSocket to the backend (WS badge). Refresh after the server is running.'
                  : undefined
              }
              className="px-4 py-1.5 rounded text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {appState === 'starting' ? 'Starting…' : '▶ Start'}
            </button>
            <button
              onClick={handleStop}
              disabled={!isListening || isBusy}
              className="px-4 py-1.5 rounded text-sm font-semibold bg-red-700 hover:bg-red-600 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {appState === 'stopping' ? 'Stopping…' : '■ Stop'}
            </button>
            {isListening && (
              <button
                onClick={handleToggleAnalysisPause}
                disabled={isBusy}
                type="button"
                title="Pause or resume OpenAI analysis; transcription continues. Run Now still works while paused."
                className={`px-3 py-1.5 rounded text-sm font-semibold transition-colors
                  disabled:opacity-40 disabled:cursor-not-allowed
                  ${
                    analysisPaused
                      ? 'bg-amber-600 hover:bg-amber-500 text-white'
                      : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                  }`}
              >
                {analysisPaused ? '▶ Resume analysis' : '⏸ Pause analysis'}
              </button>
            )}
            <button
              onClick={handleExport}
              disabled={!hasData && !hasAudio}
              className="px-3 py-1.5 rounded text-sm font-medium bg-gray-700 hover:bg-gray-600 text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Export session JSON and WAV audio"
            >
              ↓ Export
            </button>
            <button
              onClick={handleUploadAudio}
              disabled={isListening || isBusy}
              className="px-3 py-1.5 rounded text-sm font-medium bg-emerald-700 hover:bg-emerald-600 text-emerald-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Upload WAV or MP3 audio file to transcribe & diarize"
            >
              ↑ Upload Audio
            </button>
            <button
              onClick={handleImport}
              disabled={isListening || isBusy}
              className="px-3 py-1.5 rounded text-sm font-medium bg-gray-700 hover:bg-gray-600 text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Import a previously exported session"
            >
              ↑ Import
            </button>
            <button
              onClick={() => setLogPaneOpen((o) => !o)}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                logPaneOpen
                  ? 'bg-indigo-700 text-indigo-100 hover:bg-indigo-600'
                  : 'bg-gray-800 hover:bg-gray-700 text-gray-400'
              }`}
              title="Toggle LLM call log"
            >
              LLM Log{llmLogEntries.length > 0 ? ` (${llmLogEntries.length})` : ''}
            </button>
            <button
              onClick={handleClear}
              disabled={isListening || isBusy}
              className="px-3 py-1.5 rounded text-sm font-medium bg-gray-800 hover:bg-gray-700 text-gray-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Clear
            </button>
          </div>
        </div>

        {error && (
          <div className="px-3 py-1.5 bg-red-950 border border-red-800 rounded text-xs text-red-300">
            ⚠ {error}
          </div>
        )}
        {restoreOffer && (
          <div className="px-3 py-2 bg-amber-950 border border-amber-800 rounded text-xs text-amber-200 flex flex-wrap items-center gap-3">
            <span>
              Recover autosaved transcript and local recording snapshot from{' '}
              <span className="font-mono text-amber-100">
                {new Date(restoreOffer.updatedAt).toLocaleString()}
              </span>
              ?
            </span>
            {restoreOffer.sessionId && (
              <a
                href={`${API_BASE}/sessions/${encodeURIComponent(restoreOffer.sessionId)}/autosave/wav`}
                download
                className="text-amber-400 hover:text-amber-300 underline shrink-0"
              >
                Download server WAV
              </a>
            )}
            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={() => applyRestore(restoreOffer)}
                className="px-3 py-1 rounded font-semibold bg-amber-600 hover:bg-amber-500 text-white transition-colors"
              >
                Restore
              </button>
              <button
                type="button"
                onClick={() => {
                  void clearLocalSnapshot();
                  setRestoreOffer(null);
                }}
                className="px-3 py-1 rounded font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
              >
                Discard
              </button>
            </div>
          </div>
        )}
        {analysisWarning && (
          <div className="px-3 py-1.5 bg-yellow-950 border border-yellow-800 rounded text-xs text-yellow-300 flex items-center justify-between gap-3">
            <span>⚠ {analysisWarning}</span>
            <button
              onClick={() => setAnalysisWarning(null)}
              className="text-yellow-600 hover:text-yellow-300 transition-colors shrink-0"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        {(mockMode.deepgram || mockMode.openai || mockMode.diarization) && (
          <div className="px-3 py-1 bg-purple-950 border border-purple-800 rounded text-xs text-purple-300">
            Mock / disabled —{' '}
            {[
              mockMode.deepgram && 'Deepgram using sample transcript',
              mockMode.openai && 'OpenAI using mock responses',
              mockMode.diarization && 'Diarization disabled',
            ]
              .filter(Boolean)
              .join(' · ')}{' '}
            (configure server/.env to enable real services)
          </div>
        )}
      </header>

      {/* Prompt bar */}
      <div className="bg-gray-900 border-b border-gray-700 px-5 py-3 space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-xs text-gray-400 font-medium">
            Copilot Prompt
            <span className="ml-2 text-gray-600 font-normal">
              — runs every ~3 s while listening · or use Run Now
            </span>
          </label>
          <div className="flex items-center gap-2 ml-auto">
            <select
              value={openAiModel}
              onChange={(event) => handleModelChange(event.target.value)}
              disabled={isSummarizing}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-emerald-600 disabled:opacity-40"
              title="Model used for live analysis and entire-call summaries"
            >
              {OPENAI_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
            {savedPrompts.length > 0 && (
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) handleSelectSavedPrompt(e.target.value);
                }}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-emerald-600 max-w-[220px] truncate"
              >
                <option value="">— saved prompts —</option>
                {savedPrompts.map((p, i) => (
                  <option key={i} value={p}>
                    {p.length > 60 ? p.slice(0, 58) + '…' : p}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={handleSavePrompt}
              disabled={!prompt.trim() || savedPrompts.includes(prompt.trim())}
              className="px-2.5 py-1 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Save current prompt to the list"
            >
              Save
            </button>
            <button
              onClick={handleRunNow}
              disabled={!wsConnected || !prompt.trim() || isSummarizing}
              className="px-2.5 py-1 rounded text-xs font-semibold bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Run this prompt against the current transcript immediately"
            >
              ▶ Run Now
            </button>
            <button
              onClick={handleSummarizeEntireCall}
              disabled={!wsConnected || transcriptChunks.length === 0 || isSummarizing}
              className="px-2.5 py-1 rounded text-xs font-semibold bg-indigo-700 hover:bg-indigo-600 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Create a structured summary using the complete transcript"
            >
              {isSummarizing ? 'Summarizing…' : 'Summarize Entire Call'}
            </button>
          </div>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => handlePromptChange(e.target.value)}
          placeholder="e.g. What did the other person ask for? List any commitments I made."
          rows={2}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 resize-none focus:outline-none focus:border-emerald-600 transition-colors"
        />
        {summaryMessage && (
          <div className="text-xs text-indigo-300">{summaryMessage}</div>
        )}
        {savedPrompts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {savedPrompts.map((p, i) => (
              <div
                key={i}
                className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs text-gray-400 group"
              >
                <button
                  onClick={() => handleSelectSavedPrompt(p)}
                  className="hover:text-emerald-400 transition-colors text-left truncate max-w-[260px]"
                  title={p}
                >
                  {p.length > 45 ? p.slice(0, 43) + '…' : p}
                </button>
                <button
                  onClick={() => handleDeletePrompt(i)}
                  className="text-gray-600 hover:text-red-400 transition-colors ml-1 shrink-0"
                  title="Delete saved prompt"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Main panels */}
      <div
        className={`overflow-hidden p-3 min-h-0 ${
          logPaneOpen ? 'flex-none h-[55vh]' : 'flex-1'
        }`}
      >
        <PanelGroup direction="horizontal" autoSaveId="copilot-columns" className="h-full">
          <Panel defaultSize={30} minSize={18} maxSize={55} className="min-h-0">
            <PanelGroup direction="vertical" autoSaveId="copilot-left-column" className="h-full">
              <Panel defaultSize={60} minSize={15} className="min-h-0">
                <SpeakersPanel
                  knownRawSpeakers={knownRawSpeakers}
                  aliases={speakerAliases}
                  merges={speakerMerges}
                  onRename={handleRenameSpeaker}
                  onMerge={handleMergeSpeaker}
                  onUnmerge={handleUnmergeSpeaker}
                  selectedSpeaker={speakerFilter}
                  onSelectSpeaker={setSpeakerFilter}
                />
              </Panel>
              <ResizeHandle axis="y" />
              <Panel defaultSize={40} minSize={15} className="min-h-0">
                <NotesPanel notes={notes} onChange={handleNotesChange} />
              </Panel>
            </PanelGroup>
          </Panel>

          <ResizeHandle axis="x" />

          <Panel defaultSize={70} minSize={45} className="min-h-0">
            <PanelGroup direction="vertical" autoSaveId="copilot-right-column" className="h-full">
              <Panel defaultSize={60} minSize={20} className="min-h-0">
                <div className="h-full flex flex-col panel">
                  <div className="panel-header">
                    <span className="panel-title">AI Analysis</span>
                    <span className="text-xs text-gray-500">
                      {analysisResults.length} result{analysisResults.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="panel-body flex-1 overflow-y-auto space-y-4 text-sm">
                    {analysisResults.length === 0 && (
                      <p className="text-gray-600 italic text-center mt-8">
                        {prompt.trim()
                          ? 'Analysis results will appear here once listening begins…'
                          : 'Enter a prompt above, then start listening to see AI analysis…'}
                      </p>
                    )}
                    {analysisResults.map((entry, i) => (
                      <div key={i} className="border border-gray-800 rounded-lg p-3 bg-gray-900/50">
                        <div className="text-xs text-gray-600 font-mono mb-2">
                          {new Date(entry.timestamp).toLocaleTimeString('en-US', {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            hour12: false,
                          })}
                          <span className="ml-2 text-gray-700">#{i + 1}</span>
                        </div>
                        <p className="text-gray-200 leading-relaxed whitespace-pre-wrap">
                          {entry.result}
                        </p>
                      </div>
                    ))}
                    <div ref={analysisBottomRef} />
                  </div>
                </div>
              </Panel>
              <ResizeHandle axis="y" />
              <Panel defaultSize={40} minSize={15} className="min-h-0">
                <TranscriptPanel
                  chunks={visibleTranscriptChunks}
                  partialText={speakerFilter ? null : partialText}
                  livePauseSecs={speakerFilter ? null : livePauseSecs}
                  aliases={speakerAliases}
                  merges={speakerMerges}
                  knownRawSpeakers={knownRawSpeakers}
                  onRenameSpeaker={handleRenameSpeaker}
                  onMergeSpeaker={handleMergeSpeaker}
                  speakerFilter={speakerFilter}
                  onClearSpeakerFilter={() => setSpeakerFilter(null)}
                />
              </Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={handleFileSelected}
      />

      {logPaneOpen && (
        <div className="flex-1 min-h-0 border-t border-gray-700 flex flex-col bg-gray-950">
          <div className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-700 shrink-0">
            <span className="text-sm font-semibold text-indigo-300">
              LLM Call Log
              <span className="ml-2 text-xs text-gray-500 font-normal">
                {llmLogEntries.length} call{llmLogEntries.length !== 1 ? 's' : ''} · stored in
                data/llm_calls.db
              </span>
            </span>
            <button
              onClick={() => setLogPaneOpen(false)}
              className="text-gray-600 hover:text-gray-300 text-lg leading-none transition-colors"
              title="Close log"
            >
              ×
            </button>
          </div>

          {llmLogEntries.length === 0 ? (
            <p className="text-gray-600 italic text-sm text-center mt-6">
              No LLM calls yet this session.
            </p>
          ) : (
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-900 border-b border-gray-800">
                  <tr className="text-gray-500 text-left">
                    <th className="px-3 py-2 font-medium w-8">#</th>
                    <th className="px-3 py-2 font-medium">Time</th>
                    <th className="px-3 py-2 font-medium">Duration</th>
                    <th className="px-3 py-2 font-medium">Tokens in</th>
                    <th className="px-3 py-2 font-medium">Tokens out</th>
                    <th className="px-3 py-2 font-medium">Total</th>
                    <th className="px-3 py-2 font-medium">Model</th>
                    <th className="px-3 py-2 font-medium w-16"></th>
                  </tr>
                </thead>
                <tbody>
                  {llmLogEntries.map((entry, i) => {
                    const isExpanded = expandedLogIds.has(i);
                    return (
                      <React.Fragment key={i}>
                        <tr
                          className="border-b border-gray-800/50 hover:bg-gray-900/40 cursor-pointer"
                          onClick={() => toggleLogEntry(i)}
                        >
                          <td className="px-3 py-2 text-gray-600">{i + 1}</td>
                          <td className="px-3 py-2 text-gray-400 font-mono">
                            {new Date(entry.timestamp).toLocaleTimeString('en-US', {
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                              hour12: false,
                            })}
                          </td>
                          <td className="px-3 py-2 text-gray-300 font-mono">
                            {entry.durationMs.toLocaleString()} ms
                          </td>
                          <td className="px-3 py-2 text-blue-400 font-mono">
                            {entry.promptTokens.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-green-400 font-mono">
                            {entry.completionTokens.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-gray-300 font-mono">
                            {entry.totalTokens.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-gray-500 font-mono">{entry.model}</td>
                          <td className="px-3 py-2 text-gray-600 text-right">
                            {isExpanded ? '▲' : '▶'}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="border-b border-gray-700 bg-gray-900/60">
                            <td colSpan={8} className="px-4 py-3">
                              <div className="space-y-3">
                                <div>
                                  <div className="text-xs text-gray-500 font-semibold uppercase tracking-wide mb-1">
                                    System Prompt
                                  </div>
                                  <pre className="text-xs text-gray-400 bg-gray-950 rounded p-2 overflow-x-auto max-h-32 whitespace-pre-wrap font-mono leading-relaxed">
                                    {entry.systemPrompt}
                                  </pre>
                                </div>
                                <div>
                                  <div className="text-xs text-gray-500 font-semibold uppercase tracking-wide mb-1">
                                    User Prompt
                                  </div>
                                  <pre className="text-xs text-gray-400 bg-gray-950 rounded p-2 overflow-x-auto max-h-40 whitespace-pre-wrap font-mono leading-relaxed">
                                    {entry.userPrompt}
                                  </pre>
                                </div>
                                <div>
                                  <div className="text-xs text-gray-500 font-semibold uppercase tracking-wide mb-1">
                                    Response
                                  </div>
                                  <pre className="text-xs text-gray-200 bg-gray-950 rounded p-2 overflow-x-auto max-h-40 whitespace-pre-wrap font-mono leading-relaxed">
                                    {entry.response}
                                  </pre>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Hidden File Input for Audio Upload */}
      <input
        type="file"
        ref={audioUploadInputRef}
        accept="audio/wav,audio/mp3,audio/mpeg"
        onChange={handleAudioFileSelected}
        className="hidden"
      />

      {/* Loading overlay for processing */}
      {isUploading && (
        <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex flex-col items-center justify-center z-50 backdrop-blur-sm">
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 shadow-2xl flex flex-col items-center space-y-4 max-w-sm text-center font-sans">
            <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-sm font-medium text-gray-200">{uploadMessage}</p>
            <p className="text-xs text-gray-500">Processing locally on your GPU/CPU sidecar</p>
          </div>
        </div>
      )}
    </div>
  );
}
