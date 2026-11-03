// ---------------------------------------------------------------------------
// TranscriptBuffer: stores finalized transcript chunks plus the latest
// partial. Each finalized chunk carries the audio-time range Deepgram
// reported, which lets the diarization pipeline match a chunk to a speaker
// by overlapping audio time.
// ---------------------------------------------------------------------------

export interface TranscriptChunk {
  id: number;
  text: string;
  isFinal: boolean;
  timestamp: number;          // wall-clock ms
  audioStart: number | null;  // seconds from session start
  audioEnd: number | null;
  speaker: string | null;     // user-facing label, e.g. "Speaker 1"
}

export interface PartialChunk {
  text: string;
  timestamp: number;
}

export class TranscriptBuffer {
  private finalChunks: TranscriptChunk[] = [];
  private currentPartial: PartialChunk | null = null;
  private nextId = 1;
  private charsSentToReasoning = 0;

  addPartial(text: string, timestamp: number): PartialChunk {
    this.currentPartial = { text, timestamp };
    return this.currentPartial;
  }

  addFinal(input: {
    text: string;
    timestamp: number;
    audioStart: number | null;
    audioEnd: number | null;
  }): TranscriptChunk {
    const chunk: TranscriptChunk = {
      id: this.nextId++,
      text: input.text,
      isFinal: true,
      timestamp: input.timestamp,
      audioStart: input.audioStart,
      audioEnd: input.audioEnd,
      speaker: null,
    };
    this.finalChunks.push(chunk);
    this.currentPartial = null;
    return chunk;
  }

  replaceFinalChunks(
    chunks: Array<{ text: string; timestamp: number; speaker: string | null }>
  ): void {
    this.clear();
    for (const input of chunks) {
      const chunk = this.addFinal({
        text: input.text,
        timestamp: input.timestamp,
        audioStart: null,
        audioEnd: null,
      });
      chunk.speaker = input.speaker;
    }
  }

  // Apply a function (chunkId → new speaker label) to every chunk. Returns
  // the list of chunk IDs whose speaker actually changed.
  applySpeakerLabels(label: (chunk: TranscriptChunk) => string | null): number[] {
    const changed: number[] = [];
    for (const chunk of this.finalChunks) {
      const next = label(chunk);
      if (next !== chunk.speaker) {
        chunk.speaker = next;
        changed.push(chunk.id);
      }
    }
    return changed;
  }

  getPartial(): PartialChunk | null {
    return this.currentPartial;
  }

  getFinalChunks(): TranscriptChunk[] {
    return [...this.finalChunks];
  }

  // Rolling text window for the LLM. Includes speaker prefixes when known so
  // the LLM can reason about who said what.
  //
  // `merges` (raw → raw) is applied first so e.g. Speaker 3 → Speaker 1
  // collapses both into one identity. Then `aliases` (canonical → human name)
  // is applied to that canonical label.
  getRollingWindow(
    maxChars: number,
    aliases?: Record<string, string>,
    merges?: Record<string, string>
  ): string {
    const joined = this.getFormattedTranscript(aliases, merges);
    if (joined.length <= maxChars) return joined;
    return joined.slice(joined.length - maxChars);
  }

  getFormattedTranscript(
    aliases?: Record<string, string>,
    merges?: Record<string, string>
  ): string {
    const resolveCanonical = (raw: string): string => {
      if (!merges) return raw;
      const seen = new Set<string>();
      let cur = raw;
      for (let i = 0; i < 8; i++) {
        const next = merges[cur];
        if (!next || next === cur || seen.has(next)) return cur;
        seen.add(cur);
        cur = next;
      }
      return cur;
    };

    const formatted = this.finalChunks.map((c) => {
      if (!c.speaker) return c.text;
      const canon = resolveCanonical(c.speaker);
      const alias = aliases?.[canon]?.trim();
      const label = alias && alias.length > 0 ? alias : canon;
      return `${label}: ${c.text}`;
    });
    return formatted.join('\n');
  }

  newCharsSinceLastReasoning(): number {
    const total = this.finalChunks.reduce((sum, c) => sum + c.text.length, 0);
    return total - this.charsSentToReasoning;
  }

  markReasoningCalled(): void {
    this.charsSentToReasoning = this.finalChunks.reduce(
      (sum, c) => sum + c.text.length,
      0
    );
  }

  getTotalFinalText(): string {
    return this.finalChunks.map((c) => c.text).join(' ');
  }

  clear(): void {
    this.finalChunks = [];
    this.currentPartial = null;
    this.charsSentToReasoning = 0;
    this.nextId = 1;
  }

  isEmpty(): boolean {
    return this.finalChunks.length === 0;
  }
}
