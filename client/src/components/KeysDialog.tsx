import { FormEvent, useState } from 'react';
import { KEY_FIELDS, KeyId, KeyStatusMap, SavedKeys } from '../lib/apiKeys';

interface KeysDialogProps {
  status: KeyStatusMap | null;
  saving: boolean;
  error: string | null;
  onSave: (values: SavedKeys) => void;
  onContinueWithout: () => void;
}

export function KeysDialog({ status, saving, error, onSave, onContinueWithout }: KeysDialogProps) {
  const [values, setValues] = useState<SavedKeys>({});

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const entered: SavedKeys = {};
    for (const field of KEY_FIELDS) {
      const value = values[field.id]?.trim();
      if (value) entered[field.id] = value;
    }
    onSave(entered);
  };

  const setValue = (id: KeyId, value: string) => {
    setValues((prev) => ({ ...prev, [id]: value }));
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="keys-dialog-title"
    >
      <div className="flex min-h-full items-center justify-center p-4">
        <form
          onSubmit={handleSubmit}
          className="w-full max-w-lg bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-5 space-y-4"
        >
          <div>
            <h2 id="keys-dialog-title" className="text-base font-semibold text-white">
              API keys
            </h2>
            <p className="text-xs text-gray-400 mt-1">
              Keys are saved in this browser and sent to the Call Copilot server running on your
              machine. Leave a field blank to keep its current setting.
            </p>
          </div>

          {KEY_FIELDS.map((field) => {
            const source = status?.[field.id]?.source ?? 'none';
            const hint =
              source === 'browser'
                ? 'Saved in this browser'
                : source === 'env'
                ? 'Set in server/.env'
                : 'Not set';
            return (
              <div key={field.id} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <label htmlFor={`key-${field.id}`} className="text-sm font-medium text-gray-200">
                    {field.label}
                  </label>
                  <span className="text-xs text-gray-500">{hint}</span>
                </div>
                <input
                  id={`key-${field.id}`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={values[field.id] ?? ''}
                  onChange={(event) => setValue(field.id, event.target.value)}
                  placeholder={source === 'none' ? field.placeholder : 'Leave blank to keep current key'}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 font-mono focus:outline-none focus:border-emerald-600"
                />
                <p className="text-xs text-gray-500">
                  {field.help}{' '}
                  <a
                    href={field.href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-emerald-500 hover:text-emerald-400 underline"
                  >
                    Get a key
                  </a>
                </p>
              </div>
            );
          })}

          {error && (
            <div className="px-3 py-1.5 bg-red-950 border border-red-800 rounded text-xs text-red-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 pt-2">
            <button
              type="button"
              onClick={onContinueWithout}
              className="px-3 py-1.5 rounded text-sm font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
            >
              Continue without them
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-1.5 rounded text-sm font-semibold bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? 'Saving…' : 'Save keys'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
