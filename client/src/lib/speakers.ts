// ---------------------------------------------------------------------------
// Speaker label resolution — shared between the transcript view, the speakers
// panel, and the server-bound payload.
//
// `merges` is a flat raw→raw map (e.g. "Speaker 3" → "Speaker 1") meaning
// "treat Speaker 3 as Speaker 1". Chains are kept flat on write (see
// `applyMerge` below), but `canonicalLabel` still follows up to a few hops
// defensively in case data lands stale (e.g. imported from an older session).
//
// `aliases` is the human-name map (e.g. "Speaker 1" → "Jay"), keyed by the
// CANONICAL label (after merge resolution).
// ---------------------------------------------------------------------------

export function canonicalLabel(
  rawLabel: string,
  merges: Record<string, string>
): string {
  const seen = new Set<string>();
  let cur = rawLabel;
  // Cap at 8 hops to be very safe even if old data has a chain.
  for (let i = 0; i < 8; i++) {
    const next = merges[cur];
    if (!next || next === cur || seen.has(next)) return cur;
    seen.add(cur);
    cur = next;
  }
  return cur;
}

export function displayLabel(
  rawLabel: string | null,
  merges: Record<string, string>,
  aliases: Record<string, string>
): string | null {
  if (!rawLabel) return null;
  const canon = canonicalLabel(rawLabel, merges);
  const alias = aliases[canon]?.trim();
  return alias && alias.length > 0 ? alias : canon;
}

// Compute the next merges map when the user merges `source` into `target`.
// Returns the same reference if the merge would be a no-op or a cycle.
//
// Behaviour:
//   - target is resolved to its canonical first, so we don't build chains.
//   - any speakers already pointing at `source` are redirected to the
//     resolved target, keeping chains flat (depth 1).
//   - merging a speaker into itself, or into something that resolves back to
//     itself, is rejected.
export function applyMerge(
  currentMerges: Record<string, string>,
  source: string,
  target: string
): Record<string, string> {
  const resolvedTarget = canonicalLabel(target, currentMerges);
  if (resolvedTarget === source) return currentMerges;
  if (source === target) return currentMerges;
  const next: Record<string, string> = { ...currentMerges };
  next[source] = resolvedTarget;
  for (const [k, v] of Object.entries(next)) {
    if (v === source) next[k] = resolvedTarget;
  }
  return next;
}

export function applyUnmerge(
  currentMerges: Record<string, string>,
  source: string
): Record<string, string> {
  if (!(source in currentMerges)) return currentMerges;
  const next = { ...currentMerges };
  delete next[source];
  return next;
}
