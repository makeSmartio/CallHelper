// ---------------------------------------------------------------------------
// Shared types between the Call Copilot frontend and backend.
//
// (No shared package — these are kept in sync manually with the server.)
// ---------------------------------------------------------------------------

export interface LlmLogEntry {
  id?: number;
  sessionId: string;
  mode: string;
  timestamp: number;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
}

export interface TranscriptChunk {
  // Stable per-chunk id (only set on finalized chunks; partials reuse 0).
  id: number;
  text: string;
  isFinal: boolean;
  timestamp: number;
  // user-facing label like "Speaker 1", or null if diarization hasn't
  // labeled this chunk yet
  speaker: string | null;
}

export interface SpeakerUpdate {
  id: number;
  speaker: string | null;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type ServerMessage =
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

// Client → server messages (audio chunks are sent as binary, not JSON).
export type ClientMessage =
  | { type: 'start_session' }
  | { type: 'stop_session' }
  | { type: 'load_transcript'; transcriptChunks: TranscriptChunk[] }
  | { type: 'set_model'; model: string }
  | { type: 'set_prompt'; prompt: string }
  | { type: 'force_analysis'; source?: 'user' | 'silence' }
  | { type: 'summarize_call' }
  | { type: 'set_analysis_paused'; paused: boolean }
  | { type: 'set_diarization_enabled'; enabled: boolean }
  | { type: 'set_speaker_aliases'; aliases: Record<string, string> }
  | { type: 'set_speaker_merges'; merges: Record<string, string> }
  | { type: 'set_notes'; notes: string };

export type AppState = 'idle' | 'starting' | 'listening' | 'stopping';
