import type { TranscriptChunk, LlmLogEntry } from './types';

export const API_BASE = import.meta.env.VITE_API_URL ?? '';

const DB_NAME = 'call-copilot-autosave';
const STORE = 'snapshots';
const KEY = 'active';

export const LOCAL_AUTOSAVE_SCHEMA = 1;

export interface LocalSessionSnapshot {
  schemaVersion: number;
  updatedAt: number;
  sessionId: string | null;
  wasListening: boolean;
  transcriptChunks: TranscriptChunk[];
  partialText: string | null;
  prompt: string;
  analysisResults: Array<{ result: string; timestamp: number }>;
  llmLogEntries: LlmLogEntry[];
  speakerAliases: Record<string, string>;
  speakerMerges: Record<string, string>;
  notes: string;
  analysisPaused: boolean;
  mockMode: { deepgram: boolean; openai: boolean; diarization: boolean };
  audioPcm?: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
  });
}

export function concatArrayBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  let total = 0;
  for (const b of buffers) total += b.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    out.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return out.buffer;
}

export async function saveLocalSnapshot(snapshot: LocalSessionSnapshot): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB write failed'));
      tx.objectStore(STORE).put(snapshot, KEY);
    });
    db.close();
  } catch {
    /* quota / private mode */
  }
}

export async function loadLocalSnapshot(): Promise<LocalSessionSnapshot | null> {
  try {
    const db = await openDb();
    const snap = await new Promise<LocalSessionSnapshot | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as LocalSessionSnapshot | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('indexedDB read failed'));
    });
    db.close();
    return snap;
  } catch {
    return null;
  }
}

export async function clearLocalSnapshot(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB delete failed'));
      tx.objectStore(STORE).delete(KEY);
    });
    db.close();
  } catch {
    /* ignore */
  }
}

function normalizeChunks(raw: unknown): TranscriptChunk[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c: unknown, idx: number) => {
    const o = c as Record<string, unknown>;
    return {
      id: typeof o.id === 'number' ? o.id : idx + 1,
      text: typeof o.text === 'string' ? o.text : '',
      isFinal: o.isFinal !== false,
      timestamp: typeof o.timestamp === 'number' ? o.timestamp : Date.now(),
      speaker: typeof o.speaker === 'string' ? o.speaker : null,
    };
  });
}

export async function mergeAutosaveFromServer(
  sessionId: string,
  local: LocalSessionSnapshot
): Promise<LocalSessionSnapshot> {
  try {
    const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/autosave`);
    if (!res.ok) return local;
    const server = (await res.json()) as Record<string, unknown>;
    const at = typeof server.autosaveAt === 'number' ? server.autosaveAt : 0;
    if (at <= local.updatedAt) return local;
    return {
      ...local,
      updatedAt: at,
      transcriptChunks: normalizeChunks(server.transcriptChunks),
      prompt: typeof server.customPrompt === 'string' ? server.customPrompt : local.prompt,
      analysisResults: Array.isArray(server.analysisResults)
        ? (server.analysisResults as LocalSessionSnapshot['analysisResults'])
        : local.analysisResults,
      speakerAliases:
        server.speakerAliases && typeof server.speakerAliases === 'object'
          ? (server.speakerAliases as Record<string, string>)
          : local.speakerAliases,
      speakerMerges:
        server.speakerMerges && typeof server.speakerMerges === 'object'
          ? (server.speakerMerges as Record<string, string>)
          : local.speakerMerges,
      notes: typeof server.notes === 'string' ? server.notes : local.notes,
      partialText: null,
    };
  } catch {
    return local;
  }
}
