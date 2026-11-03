import React, { useEffect, useRef, useState } from 'react';
import { TranscriptChunk } from '../lib/types';
import { canonicalLabel, displayLabel } from '../lib/speakers';

interface TranscriptPanelProps {
  chunks: TranscriptChunk[];
  partialText: string | null;
  livePauseSecs?: number | null;
  aliases: Record<string, string>;
  merges: Record<string, string>;
  /** Raw speaker labels from the full (unfiltered) transcript, for chips/merge. */
  knownRawSpeakers: string[];
  onRenameSpeaker: (rawLabel: string, newName: string) => void;
  onMergeSpeaker: (source: string, target: string) => void;
  speakerFilter?: string | null;
  onClearSpeakerFilter?: () => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

// Color per speaker number, cycling. Keyed to the CANONICAL "Speaker N" label
// so renaming doesn't change a person's color AND merged speakers share one.
const SPEAKER_COLORS = [
  'text-emerald-400',
  'text-sky-400',
  'text-pink-400',
  'text-amber-400',
  'text-violet-400',
  'text-rose-400',
];

function speakerColor(
  rawLabel: string | null,
  merges: Record<string, string>
): string {
  if (!rawLabel) return 'text-gray-500';
  const canon = canonicalLabel(rawLabel, merges);
  const m = canon.match(/(\d+)/);
  if (!m) return 'text-gray-300';
  const idx = (parseInt(m[1], 10) - 1) % SPEAKER_COLORS.length;
  return SPEAKER_COLORS[idx];
}

interface SpeakerChipProps {
  canonLabel: string;
  alias: string | undefined;
  allCanonicals: string[];
  aliases: Record<string, string>;
  onRename: (canonLabel: string, newName: string) => void;
  onMerge: (source: string, target: string) => void;
  isActive: boolean;
  onToggle: () => void;
  onClose: () => void;
}

const SpeakerChip: React.FC<SpeakerChipProps> = ({
  canonLabel,
  alias,
  allCanonicals,
  aliases,
  onRename,
  onMerge,
  isActive,
  onToggle,
  onClose,
}) => {
  const [draft, setDraft] = useState(alias ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (isActive) {
      setDraft(alias ?? '');
      // Defer focus so the input is mounted before we select it.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isActive, alias]);

  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isActive]);

  // Color is keyed off the canonical label directly — no need to walk merges
  // again here since the parent already resolved it.
  const color = speakerColor(canonLabel, {});
  const shown = alias && alias.trim().length > 0 ? alias : canonLabel;
  const mergeTargets = allCanonicals.filter((other) => other !== canonLabel);

  const commitRename = () => {
    onRename(canonLabel, draft.trim());
  };

  if (isActive) {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-gray-700 bg-gray-900 px-1 py-0.5">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitRename();
              onClose();
            }
          }}
          placeholder={canonLabel}
          className={`bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs font-medium ${color} placeholder-gray-600 focus:outline-none focus:border-emerald-600 w-28`}
        />
        {mergeTargets.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) {
                onMerge(canonLabel, e.target.value);
                onClose();
              }
              e.target.value = '';
            }}
            className="bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-xs text-gray-400 focus:outline-none focus:border-emerald-600 max-w-[140px]"
            title="Merge this speaker into another"
          >
            <option value="">merge into…</option>
            {mergeTargets.map((t) => {
              const targetAlias = aliases[t]?.trim();
              const label =
                targetAlias && targetAlias.length > 0 ? `${targetAlias} (${t})` : t;
              return (
                <option key={t} value={t}>
                  {label}
                </option>
              );
            })}
          </select>
        )}
        <button
          type="button"
          onClick={onClose}
          className="px-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          title="Done"
        >
          ×
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      title={`Label ${canonLabel}`}
      className={`px-1.5 py-0 text-xs font-medium ${color} hover:bg-gray-800 rounded transition-colors`}
    >
      {shown}
    </button>
  );
};

export const TranscriptPanel: React.FC<TranscriptPanelProps> = ({
  chunks,
  partialText,
  livePauseSecs,
  aliases,
  merges,
  knownRawSpeakers,
  onRenameSpeaker,
  onMergeSpeaker,
  speakerFilter,
  onClearSpeakerFilter,
}) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [activeChip, setActiveChip] = useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chunks, partialText, livePauseSecs]);

  const isEmpty = chunks.length === 0 && !partialText;
  // Chips in the header are deduped to CANONICAL speakers so merged
  // siblings (e.g. Speaker 3 → Speaker 1) collapse into a single chip.
  // Built from the full transcript so merge targets stay available when filtered.
  const knownCanonicals = Array.from(
    new Set(knownRawSpeakers.map((s) => canonicalLabel(s, merges)))
  );

  return (
    <div className="panel h-full">
      <div className="panel-header flex-wrap gap-y-1">
        <div className="flex items-center gap-2">
          <span className="panel-title">Live Transcript</span>
          {speakerFilter && (
            <button
              type="button"
              onClick={onClearSpeakerFilter}
              className="rounded bg-emerald-950 px-2 py-0.5 text-[11px] font-medium text-emerald-300 hover:bg-emerald-900 transition-colors"
              title="Clear speaker filter"
            >
              {displayLabel(speakerFilter, merges, aliases) ?? speakerFilter} only ×
            </button>
          )}
        </div>
        <span className="text-xs text-gray-500 flex items-center gap-1 flex-wrap">
          {chunks.filter((c) => c.id >= 0).length} segments
          {knownCanonicals.length > 0 && (
            <>
              <span className="text-gray-700">·</span>
              {knownCanonicals.map((canon) => (
                <SpeakerChip
                  key={canon}
                  canonLabel={canon}
                  alias={aliases[canon]}
                  allCanonicals={knownCanonicals}
                  aliases={aliases}
                  onRename={onRenameSpeaker}
                  onMerge={onMergeSpeaker}
                  isActive={activeChip === canon}
                  onToggle={() =>
                    setActiveChip((prev) => (prev === canon ? null : canon))
                  }
                  onClose={() => setActiveChip(null)}
                />
              ))}
              <span className="text-gray-700 italic">(click to label)</span>
            </>
          )}
        </span>
      </div>
      <div className="panel-body space-y-2 text-sm leading-relaxed">
        {isEmpty && (
          <p className="text-gray-600 italic text-center mt-8">
            {speakerFilter
              ? 'No transcript segments match this speaker.'
              : 'Transcript will appear here once listening begins…'}
          </p>
        )}

        {chunks.map((chunk, i) => {
          const isPause = chunk.text.startsWith('⏸');
          if (isPause) {
            return (
              <div key={`pause-${i}`} className="flex items-center gap-2 my-1">
                <span className="text-gray-700 text-xs font-mono shrink-0 w-16 text-right">
                  {formatTime(chunk.timestamp)}
                </span>
                <span className="flex-1 border-t border-dashed border-gray-700" />
                <span className="text-xs text-amber-600/80 font-mono shrink-0">{chunk.text}</span>
                <span className="flex-1 border-t border-dashed border-gray-700" />
              </div>
            );
          }
          const color = speakerColor(chunk.speaker, merges);
          const shown = displayLabel(chunk.speaker, merges, aliases);
          return (
            <div key={chunk.id || `c-${i}`} className="group flex gap-2">
              <span className="text-gray-600 text-xs font-mono pt-0.5 shrink-0 w-16 text-right">
                {formatTime(chunk.timestamp)}
              </span>
              <div className="flex-1 min-w-0">
                <div
                  className={`text-[11px] font-semibold uppercase tracking-wider ${color} transition-colors`}
                >
                  {shown ?? <span className="text-gray-700">Speaker ?</span>}
                </div>
                <p className="text-gray-200">{chunk.text}</p>
              </div>
            </div>
          );
        })}

        {partialText && (
          <div className="flex gap-2 opacity-60">
            <span className="text-gray-600 text-xs font-mono pt-0.5 shrink-0 w-16 text-right">…</span>
            <p className="text-gray-400 italic">{partialText}</p>
          </div>
        )}

        {livePauseSecs != null && livePauseSecs > 0 && (
          <div className="flex items-center gap-2 animate-pulse">
            <span className="text-gray-700 text-xs font-mono shrink-0 w-16 text-right">now</span>
            <span className="flex-1 border-t border-dashed border-amber-800/50" />
            <span className="text-xs text-amber-500/70 font-mono shrink-0">⏸ {livePauseSecs}s…</span>
            <span className="flex-1 border-t border-dashed border-amber-800/50" />
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
};
