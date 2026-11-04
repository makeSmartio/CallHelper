import { API_BASE } from './sessionAutosave';

export const KEY_IDS = ['deepgram', 'openai', 'anthropic', 'xai', 'huggingface'] as const;
export type KeyId = (typeof KEY_IDS)[number];

export type KeyStatusMap = Record<KeyId, { configured: boolean; source: 'env' | 'browser' | 'none' }>;
export type SavedKeys = Partial<Record<KeyId, string>>;

export const KEY_FIELDS: Array<{ id: KeyId; label: string; help: string; href: string; placeholder: string }> = [
  {
    id: 'deepgram',
    label: 'Deepgram',
    help: 'Live transcription. Blank keeps local Parakeet.',
    href: 'https://console.deepgram.com/',
    placeholder: 'Deepgram API key',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    help: 'Live analysis and summaries. Blank keeps mock analysis.',
    href: 'https://platform.openai.com/',
    placeholder: 'OpenAI API key',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    help: 'Claude models only.',
    href: 'https://platform.claude.com/',
    placeholder: 'Anthropic API key',
  },
  {
    id: 'xai',
    label: 'xAI',
    help: 'Grok models only.',
    href: 'https://console.x.ai/',
    placeholder: 'xAI API key',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    help: 'Speaker diarization. Blank leaves diarization off. Accept the pyannote model terms first.',
    href: 'https://hf.co/settings/tokens',
    placeholder: 'Hugging Face token',
  },
];

const SAVED_KEYS_STORAGE = 'copilot_api_keys';
const DISMISSED_STORAGE = 'copilot_keys_dismissed';

function nonEmpty(values: SavedKeys): SavedKeys {
  const out: SavedKeys = {};
  for (const id of KEY_IDS) {
    const value = values[id]?.trim();
    if (value) out[id] = value;
  }
  return out;
}

export function loadSavedKeys(): SavedKeys {
  try {
    const raw = localStorage.getItem(SAVED_KEYS_STORAGE);
    if (!raw) return {};
    return nonEmpty(JSON.parse(raw) as SavedKeys);
  } catch {
    return {};
  }
}

export function storeKeys(values: SavedKeys): void {
  try {
    localStorage.setItem(SAVED_KEYS_STORAGE, JSON.stringify({ ...loadSavedKeys(), ...nonEmpty(values) }));
  } catch {
    // Storage can be unavailable (private mode); keys still apply to this server run.
  }
}

export function isKeysDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_STORAGE) === 'true';
  } catch {
    return false;
  }
}

export function setKeysDismissed(dismissed: boolean): void {
  try {
    localStorage.setItem(DISMISSED_STORAGE, String(dismissed));
  } catch {
    // Ignore; the dialog may reappear on refresh.
  }
}

export function hasMissingKeys(status: KeyStatusMap): boolean {
  return KEY_IDS.some((id) => !status[id]?.configured);
}

export async function getKeyStatus(): Promise<KeyStatusMap | null> {
  try {
    const res = await fetch(`${API_BASE}/keys`);
    if (!res.ok) return null;
    const data = (await res.json()) as { keys: KeyStatusMap };
    return data.keys;
  } catch {
    return null;
  }
}

export async function postKeys(
  values: SavedKeys
): Promise<{ keys: KeyStatusMap; sidecarError: string | null } | null> {
  const body = nonEmpty(values);
  try {
    const res = await fetch(`${API_BASE}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as { keys: KeyStatusMap; sidecarError: string | null };
  } catch {
    return null;
  }
}
