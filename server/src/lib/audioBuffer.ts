// ---------------------------------------------------------------------------
// AudioBuffer: accumulates the raw PCM audio for a single session, so we can
// hand it to the pyannote sidecar every ~10 seconds for diarization.
//
// The browser streams PCM16 mono @ 16 kHz, little-endian. We append it
// verbatim and can produce a WAV at any moment.
//
// Memory cost: 16,000 samples/sec × 2 bytes ≈ 32 KB/s = ~2 MB/min.
// For typical 30-60 minute calls that's well within Node's default heap.
// ---------------------------------------------------------------------------

import { config } from '../config';

export class SessionAudioBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;

  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
  }

  // How many seconds of audio we have, based on the PCM byte count.
  durationSeconds(): number {
    return this.totalBytes / (config.sampleRate * config.bytesPerSample);
  }

  byteLength(): number {
    return this.totalBytes;
  }

  // Build a 16-bit mono 16 kHz WAV from everything we have so far.
  toWav(): Buffer {
    const pcm = Buffer.concat(this.chunks, this.totalBytes);
    return wrapPcmAsWav(pcm, config.sampleRate, 1, config.bytesPerSample * 8);
  }

  // Build a WAV of just the trailing `windowSeconds` of audio, so periodic
  // diarization passes don't reprocess the whole (growing) session every
  // time. Returns the absolute session-time offset of the window's start
  // (0 if the whole session fits inside the window) so callers can map
  // window-relative segment times back to session-absolute time.
  getWindowWav(windowSeconds: number): { wav: Buffer; windowStartSeconds: number } {
    const bytesPerSecond = config.sampleRate * config.bytesPerSample;
    const windowBytes = Math.floor(windowSeconds * bytesPerSecond);

    if (this.totalBytes <= windowBytes) {
      return { wav: this.toWav(), windowStartSeconds: 0 };
    }

    // Walk chunks from the end backward until we've accumulated windowBytes.
    let collected = 0;
    let boundaryIndex = this.chunks.length;
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      collected += this.chunks[i].length;
      boundaryIndex = i;
      if (collected >= windowBytes) break;
    }

    // Trim the boundary chunk's head so the window is exactly windowBytes
    // (rounded down to a whole 16-bit sample so we never split a sample).
    const excess = collected - windowBytes;
    const headTrim = excess - (excess % config.bytesPerSample);
    const tailChunks = this.chunks.slice(boundaryIndex);
    tailChunks[0] = tailChunks[0].subarray(headTrim);

    const pcm = Buffer.concat(tailChunks);
    const windowStartSeconds = this.durationSeconds() - pcm.length / bytesPerSecond;

    return {
      wav: wrapPcmAsWav(pcm, config.sampleRate, 1, config.bytesPerSample * 8),
      windowStartSeconds,
    };
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}

// Build a minimal RIFF/WAV header around raw PCM data.
export function wrapPcmAsWav(
  pcm: Buffer,
  sampleRate: number,
  numChannels: number,
  bitsPerSample: number
): Buffer {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // fmt chunk size
  header.writeUInt16LE(1, 20);           // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm], header.length + pcm.length);
}
