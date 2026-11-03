// ---------------------------------------------------------------------------
// Diarization client — talks to the local pyannote FastAPI sidecar.
//
// Posts a WAV of a trailing window of session audio (or the whole session,
// for the final pass) and gets back speaker segments. We use the global
// fetch + FormData (Node 18+).
//
// Because periodic passes only see a window of audio, pyannote's raw
// "SPEAKER_NN" cluster ids are only meaningful *within a single call* — the
// same string can refer to a different physical speaker in a later window.
// So instead of tracking raw ids across calls, we round-trip this session's
// speaker voice embeddings ("known_speakers") to the sidecar on every call;
// it resolves each cluster against them (and against named /enroll profiles)
// before we ever see the response. Any cluster the sidecar couldn't resolve
// is a genuinely new speaker and gets the next "Speaker N" number.
// ---------------------------------------------------------------------------

import { config } from '../config';

export interface DiarSegment {
  start: number;            // seconds from start of audio
  end: number;              // seconds from start of audio
  speaker: string;          // resolved label: "Speaker N", a profile name, or (if unresolved) raw "SPEAKER_00"
}

export interface DiarResult {
  segments: DiarSegment[];
  duration: number;
  num_speakers: number;
  took_ms: number;
  speaker_embeddings: Record<string, number[]>;
}

interface Centroid {
  sum: number[];
  count: number;
}

export class DiarizationClient {
  private nextSpeakerNumber = 1;
  // Running voice-embedding centroid per stable "Speaker N" label, used to
  // re-identify a speaker in later windows after their earlier audio has
  // scrolled out of the trailing window. Named profiles aren't tracked here
  // — the sidecar matches those fresh from disk on every call.
  private centroids = new Map<string, Centroid>();

  reset(): void {
    this.nextSpeakerNumber = 1;
    this.centroids.clear();
  }

  enabled(): boolean {
    return config.useDiarization;
  }

  // POST the WAV to the sidecar. `windowStartSeconds` is the session-time
  // offset of `wav`'s start (0 for the whole-session/final pass) — segment
  // times in the response are shifted by it so callers always get
  // session-absolute times. Returns null on any failure so the caller can
  // keep going (transcript-only mode).
  async diarize(wav: Buffer, windowStartSeconds = 0): Promise<DiarResult | null> {
    if (!config.useDiarization) return null;

    const url = `${config.diarizationUrl.replace(/\/$/, '')}/diarize`;

    try {
      const form = new FormData();
      const blob = new Blob([wav], { type: 'audio/wav' });
      form.append('audio', blob, 'session.wav');

      const knownSpeakers = this.getKnownSpeakers();
      if (knownSpeakers.length > 0) {
        form.append('known_speakers', JSON.stringify(knownSpeakers));
      }

      const res = await fetch(url, { method: 'POST', body: form });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn(
          `[Diarization] sidecar returned ${res.status} ${res.statusText}: ${body.slice(0, 200)}`
        );
        return null;
      }
      const json = (await res.json()) as DiarResult;

      // Mint a stable "Speaker N" for every raw cluster id the sidecar
      // couldn't resolve, one per distinct raw id in *this* response only.
      const rawToStable = new Map<string, string>();
      for (const seg of json.segments) {
        if (/^SPEAKER_\d+$/i.test(seg.speaker) && !rawToStable.has(seg.speaker)) {
          rawToStable.set(seg.speaker, `Speaker ${this.nextSpeakerNumber++}`);
        }
      }
      for (const seg of json.segments) {
        const stable = rawToStable.get(seg.speaker);
        if (stable) seg.speaker = stable;
      }

      // Fold this pass's embeddings into running centroids so future calls
      // can re-identify these speakers by voice. Only track session-local
      // "Speaker N" identities (newly minted above, or already known from a
      // prior pass) — named-profile matches are re-resolved from disk every
      // time and don't need session-side tracking.
      for (const [label, embedding] of Object.entries(json.speaker_embeddings ?? {})) {
        const stableLabel = rawToStable.get(label) ?? label;
        if (rawToStable.has(label) || this.centroids.has(stableLabel)) {
          this.updateCentroid(stableLabel, embedding);
        }
      }

      if (windowStartSeconds) {
        for (const seg of json.segments) {
          seg.start += windowStartSeconds;
          seg.end += windowStartSeconds;
        }
      }

      return json;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Diarization] sidecar call failed: ${message}`);
      return null;
    }
  }

  private updateCentroid(label: string, embedding: number[]): void {
    const existing = this.centroids.get(label);
    if (!existing) {
      this.centroids.set(label, { sum: [...embedding], count: 1 });
      return;
    }
    for (let i = 0; i < embedding.length; i++) {
      existing.sum[i] = (existing.sum[i] ?? 0) + embedding[i];
    }
    existing.count += 1;
  }

  private getKnownSpeakers(): Array<{ label: string; embedding: number[] }> {
    const known: Array<{ label: string; embedding: number[] }> = [];
    for (const [label, { sum, count }] of this.centroids) {
      const mean = sum.map((v) => v / count);
      const norm = Math.sqrt(mean.reduce((s, v) => s + v * v, 0)) || 1;
      known.push({ label, embedding: mean.map((v) => v / norm) });
    }
    return known;
  }

  // By the time segments leave diarize(), speakers are already fully
  // resolved (profile name, matched "Speaker N", or freshly minted
  // "Speaker N"). Kept for the null-passthrough callers rely on.
  labelFor(rawSpeaker: string | null): string | null {
    return rawSpeaker;
  }
}

// Given diarization segments and a transcript chunk's audio time range,
// pick the speaker whose segment overlaps the chunk the most. Returns null
// if there's no overlap at all.
export function pickSpeakerForRange(
  segments: DiarSegment[],
  audioStart: number,
  audioEnd: number
): string | null {
  if (audioEnd <= audioStart) return null;

  let bestSpeaker: string | null = null;
  let bestOverlap = 0;

  for (const seg of segments) {
    const overlap = Math.max(0, Math.min(audioEnd, seg.end) - Math.max(audioStart, seg.start));
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestSpeaker = seg.speaker;
    }
  }

  return bestSpeaker;
}
