import dotenv from 'dotenv';
import path from 'path';
import { getKey } from '../lib/runtimeKeys';

dotenv.config({ path: path.resolve(__dirname, '../../server/.env') });

// Keys and key-derived flags are getters so browser-entered keys (see
// lib/runtimeKeys.ts) are read at the moment they are used.
export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: parseInt(process.env.PORT ?? '3001', 10),
  get deepgramApiKey(): string {
    return getKey('deepgram');
  },
  get openAiApiKey(): string {
    return getKey('openai');
  },
  openAiModel: process.env.OPENAI_MODEL ?? 'gpt-5.6-terra',
  get anthropicApiKey(): string {
    return getKey('anthropic');
  },
  get xaiApiKey(): string {
    return getKey('xai');
  },

  // Derived: use mock/local services when keys are absent
  useMockDeepgram: process.env.TRANSCRIPTION_SERVICE === 'mock',
  get useLocalWhisper(): boolean {
    return process.env.TRANSCRIPTION_SERVICE === 'whisper-local' || (!getKey('deepgram') && process.env.TRANSCRIPTION_SERVICE !== 'mock');
  },
  get useMockOpenAI(): boolean {
    return !getKey('openai') && !getKey('anthropic') && !getKey('xai');
  },

  // Pyannote sidecar
  diarizationUrl: process.env.DIARIZATION_URL ?? '',
  // True when the sidecar URL is set. The sidecar also serves local Parakeet.
  sidecarConfigured: Boolean(process.env.DIARIZATION_URL),
  diarizationIntervalMs: parseInt(process.env.DIARIZATION_INTERVAL_MS ?? '10000', 10),
  // How many trailing seconds of session audio each periodic diarization
  // pass reprocesses, instead of the whole (growing) session. Bounds
  // per-pass compute independent of call length; floored so pyannote always
  // has enough audio per speaker to produce a usable embedding. The final
  // end-of-session pass still uses the full session audio.
  diarizationWindowSeconds: Math.max(
    20,
    parseInt(process.env.DIARIZATION_WINDOW_SECONDS ?? '120', 10)
  ),
  // Derived: diarization needs the sidecar URL and a Hugging Face token
  get useDiarization(): boolean {
    return Boolean(process.env.DIARIZATION_URL) && Boolean(getKey('huggingface'));
  },

  // Audio format we capture from the browser (matches client/public/pcm-processor.js)
  sampleRate: 16000,
  bytesPerSample: 2,

  // Rolling transcript window sent to OpenAI (characters)
  transcriptWindowChars: 3000,
  minNewCharsForReasoning: 40,
  reasoningIntervalMs: 3000,

  // Where session JSON files get written
  sessionDir: path.resolve(__dirname, '../../data/sessions'),

  // While a session is live, write `{id}.autosave.json` (+ `.autosave.wav`) on this interval.
  sessionAutosaveIntervalMs: parseInt(process.env.SESSION_AUTOSAVE_INTERVAL_MS ?? '20000', 10),
} as const;

if (config.useMockDeepgram) {
  console.warn('[Config] Running in MOCK mode for transcription');
} else if (config.useLocalWhisper) {
  console.log('[Config] Running in LOCAL WHISPER mode for transcription');
}
if (config.useMockOpenAI) {
  console.warn('[Config] OpenAI key not set — running in MOCK mode for AI analysis');
}
if (!config.anthropicApiKey) {
  console.warn('[Config] Anthropic key not set — Claude models unavailable');
}
if (!config.xaiApiKey) {
  console.warn('[Config] xAI key not set — Grok unavailable');
}
if (!config.useDiarization) {
  console.warn('[Config] Diarization off — needs DIARIZATION_URL and a Hugging Face token');
}
