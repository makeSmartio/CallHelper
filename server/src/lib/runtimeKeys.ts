// ---------------------------------------------------------------------------
// Runtime API key store.
//
// Keys entered in the browser are held here in memory for this server
// process. A non-empty browser value takes precedence; otherwise the value
// from the environment (server/.env) is used. Values are never written back
// to disk and are never returned by the API.
// ---------------------------------------------------------------------------

export type KeyName = 'deepgram' | 'openai' | 'anthropic' | 'xai' | 'huggingface';

const ENV_NAMES: Record<KeyName, string> = {
  deepgram: 'DEEPGRAM_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  xai: 'XAI_API_KEY',
  huggingface: 'HF_TOKEN',
};

const KEY_NAMES = Object.keys(ENV_NAMES) as KeyName[];

const overrides: Partial<Record<KeyName, string>> = {};

export function getKey(name: KeyName): string {
  return overrides[name] || process.env[ENV_NAMES[name]] || '';
}

export function setKey(name: KeyName, value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  overrides[name] = trimmed;
  return true;
}

export function isKeyName(value: string): value is KeyName {
  return (KEY_NAMES as string[]).includes(value);
}

export type KeyStatus = { configured: boolean; source: 'env' | 'browser' | 'none' };

export function keyStatus(): Record<KeyName, KeyStatus> {
  const result = {} as Record<KeyName, KeyStatus>;
  for (const name of KEY_NAMES) {
    if (overrides[name]) {
      result[name] = { configured: true, source: 'browser' };
    } else if (process.env[ENV_NAMES[name]]) {
      result[name] = { configured: true, source: 'env' };
    } else {
      result[name] = { configured: false, source: 'none' };
    }
  }
  return result;
}
