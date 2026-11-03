import React, { useState, useRef } from 'react';
import { canonicalLabel } from '../lib/speakers';
import { startAudioCapture, AudioCapture } from '../lib/ws';
import { API_BASE } from '../lib/sessionAutosave';

interface SpeakersPanelProps {
  knownRawSpeakers: string[];
  aliases: Record<string, string>;
  merges: Record<string, string>;
  onRename: (rawLabel: string, newName: string) => void;
  onMerge: (source: string, target: string) => void;
  onUnmerge: (source: string) => void;
  selectedSpeaker: string | null;
  onSelectSpeaker: (canonicalLabel: string | null) => void;
}

const SPEAKER_COLORS = [
  'text-emerald-400',
  'text-sky-400',
  'text-pink-400',
  'text-amber-400',
  'text-violet-400',
  'text-rose-400',
];

function speakerColor(label: string): string {
  const m = label.match(/(\d+)/);
  if (!m) return 'text-gray-300';
  const idx = (parseInt(m[1], 10) - 1) % SPEAKER_COLORS.length;
  return SPEAKER_COLORS[idx];
}

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

export const SpeakersPanel: React.FC<SpeakersPanelProps> = ({
  knownRawSpeakers,
  aliases,
  merges,
  onRename,
  onMerge,
  onUnmerge,
  selectedSpeaker,
  onSelectSpeaker,
}) => {
  const [collapsed, setCollapsed] = useState(false);

  // Voice enrollment state
  const [isRecording, setIsRecording] = useState(false);
  const [enrollName, setEnrollName] = useState('');
  const [enrollStatus, setEnrollStatus] = useState<string | null>(null);
  const [recordTime, setRecordTime] = useState(0);

  const audioChunksRef = useRef<ArrayBuffer[]>([]);
  const audioCaptureRef = useRef<AudioCapture | null>(null);
  const timerRef = useRef<number | null>(null);

  const startRecording = async () => {
    if (!enrollName.trim()) {
      setEnrollStatus('Please enter a name first');
      return;
    }
    try {
      setEnrollStatus('Initializing mic...');
      audioChunksRef.current = [];
      setIsRecording(true);
      setRecordTime(0);

      const capture = await startAudioCapture((buffer) => {
        audioChunksRef.current.push(buffer.slice(0));
      });
      audioCaptureRef.current = capture;
      setEnrollStatus('Recording...');

      let count = 0;
      timerRef.current = window.setInterval(() => {
        count += 1;
        setRecordTime(count);
        if (count >= 10) {
          void stopRecording(true);
        }
      }, 1000);
    } catch (err) {
      setIsRecording(false);
      setEnrollStatus('Failed to access mic');
      console.error(err);
    }
  };

  const stopRecording = async (shouldUpload = true) => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (audioCaptureRef.current) {
      audioCaptureRef.current.stop();
      audioCaptureRef.current = null;
    }
    setIsRecording(false);

    if (!shouldUpload || audioChunksRef.current.length === 0) {
      setEnrollStatus('Cancelled');
      return;
    }

    setEnrollStatus('Uploading...');
    try {
      const blob = encodeWav(audioChunksRef.current);
      const res = await fetch(`${API_BASE}/enroll?name=${encodeURIComponent(enrollName.trim())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'audio/wav',
        },
        body: blob,
      });
      if (res.ok) {
        setEnrollStatus(`Success! '${enrollName.trim()}' enrolled.`);
        setEnrollName('');
      } else {
        const text = await res.text();
        setEnrollStatus(`Failed: ${text}`);
      }
    } catch (err) {
      setEnrollStatus('Upload failed');
      console.error(err);
    }
  };

  const rows = knownRawSpeakers.map((raw) => {
    const canon = canonicalLabel(raw, merges);
    const isMerged = canon !== raw;
    const alias = aliases[canon]?.trim() ?? '';
    return { raw, canon, isMerged, alias };
  });

  return (
    <div className={`panel shrink-0 ${collapsed ? '' : 'h-[320px]'} flex flex-col`}>
      <div className="panel-header">
        <span className="panel-title">Speakers</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">
            {rows.length} detected
            {Object.keys(merges).length > 0 && (
              <> · {Object.keys(merges).length} merged</>
            )}
          </span>
          {selectedSpeaker && (
            <button
              type="button"
              onClick={() => onSelectSpeaker(null)}
              className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
              title="Show all speakers"
            >
              clear filter
            </button>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-1.5 text-sm">
            {rows.length === 0 && (
              <p className="text-gray-600 italic text-xs text-center mt-4">
                No speakers detected yet. Start listening to see them appear here.
              </p>
            )}

            {rows.map(({ raw, canon, isMerged, alias }) => {
              const color = speakerColor(canon);
              const mergeTargets = knownRawSpeakers.filter(
                (other) => other !== raw && canonicalLabel(other, merges) !== raw
              );
              return (
                <div
                  key={raw}
                  role="button"
                  tabIndex={0}
                  onClick={() =>
                    onSelectSpeaker(selectedSpeaker === canon ? null : canon)
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelectSpeaker(selectedSpeaker === canon ? null : canon);
                    }
                  }}
                  className={`flex items-center gap-2 group rounded px-1 py-0.5 cursor-pointer transition-colors ${
                    selectedSpeaker === canon
                      ? 'bg-emerald-950/70 ring-1 ring-emerald-700'
                      : 'hover:bg-gray-800'
                  }`}
                  title={`Show only ${alias.length > 0 ? alias : canon} in the transcript`}
                >
                  <span
                    className={`text-[11px] font-semibold uppercase tracking-wider ${color} w-20 shrink-0`}
                    title={isMerged ? `Merged into ${canon}` : raw}
                  >
                    {raw}
                  </span>

                  {isMerged ? (
                    <>
                      <span className="text-gray-500 text-xs shrink-0">→</span>
                      <span className={`${color} font-medium text-xs flex-1 truncate`}>
                        {alias.length > 0 ? alias : canon}
                      </span>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onUnmerge(raw);
                        }}
                        className="text-xs text-gray-500 hover:text-amber-400 transition-colors shrink-0"
                        title="Unmerge this speaker"
                      >
                        unmerge
                      </button>
                    </>
                  ) : (
                    <>
                      <input
                        type="text"
                        value={alias}
                        placeholder="Name…"
                        onChange={(e) => onRename(raw, e.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-emerald-600"
                      />
                      {mergeTargets.length > 0 && (
                        <select
                          value=""
                          onChange={(e) => {
                            if (e.target.value) onMerge(raw, e.target.value);
                            e.target.value = '';
                          }}
                          onClick={(event) => event.stopPropagation()}
                          className="bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-xs text-gray-400 focus:outline-none focus:border-emerald-600 shrink-0 max-w-[120px]"
                          title="Merge this speaker into another"
                        >
                          <option value="">merge into…</option>
                          {mergeTargets.map((t) => {
                            const targetCanon = canonicalLabel(t, merges);
                            const targetAlias = aliases[targetCanon]?.trim();
                            const label =
                              targetAlias && targetAlias.length > 0
                                ? `${targetAlias} (${targetCanon})`
                                : targetCanon;
                            return (
                              <option key={t} value={t}>
                                {label}
                              </option>
                            );
                          })}
                        </select>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* Voice Profile Enrollment */}
          <div className="border-t border-gray-700 px-3 py-2.5 bg-gray-900 bg-opacity-40 space-y-2 shrink-0">
            <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
              Enroll Voice Profile (Voiceprint)
            </div>
            <div className="flex gap-2 items-center">
              <input
                type="text"
                value={enrollName}
                disabled={isRecording}
                placeholder="Voice Name (e.g. Me)"
                onChange={(e) => setEnrollName(e.target.value)}
                className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-emerald-600"
              />
              {isRecording ? (
                <button
                  type="button"
                  onClick={() => stopRecording(true)}
                  className="bg-red-600 hover:bg-red-700 text-white rounded px-2.5 py-1 text-xs font-semibold transition-colors shrink-0"
                >
                  Stop ({10 - recordTime}s)
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startRecording}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white rounded px-2.5 py-1 text-xs font-semibold transition-colors shrink-0"
                >
                  Record
                </button>
              )}
            </div>
            {enrollStatus && (
              <div
                className={`text-[10px] ${
                  enrollStatus.startsWith('Success')
                    ? 'text-emerald-400'
                    : enrollStatus.startsWith('Failed') || enrollStatus.startsWith('Please')
                    ? 'text-red-400'
                    : 'text-gray-400'
                }`}
              >
                {enrollStatus}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
