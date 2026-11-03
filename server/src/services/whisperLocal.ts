// ---------------------------------------------------------------------------
// Local Whisper streaming transcription service client.
//
// Connects to the python FastAPI sidecar over WebSocket and forwards raw
// mono 16kHz PCM audio buffers. Handles results in the same interface
// format as DeepgramService.
// ---------------------------------------------------------------------------

import WebSocket from 'ws';
import { config } from '../config';

export type TranscriptCallback = (chunk: {
  text: string;
  isFinal: boolean;
  timestamp: number;       // wall-clock ms when received
  audioStart: number | null; // seconds, relative to session start
  audioEnd: number | null;
}) => void;

export type StatusCallback = (
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
) => void;

export class WhisperLocalService {
  private ws: WebSocket | null = null;
  private isReady = false;

  async start(
    onTranscript: TranscriptCallback,
    onStatus: StatusCallback
  ): Promise<void> {
    if (!config.useLocalWhisper) return;

    onStatus('connecting');

    // Replace http:// or https:// with ws:// or wss://
    const wsUrl = config.diarizationUrl
      .replace(/^http/, 'ws')
      .replace(/\/$/, '') + '/stream-transcribe';

    console.log(`[WhisperLocal] Connecting to sidecar at ${wsUrl}`);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('[WhisperLocal] Connection opened successfully');
        this.isReady = true;
        onStatus('connected');
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.text !== undefined) {
            onTranscript({
              text: msg.text,
              isFinal: Boolean(msg.isFinal),
              timestamp: Date.now(),
              audioStart: typeof msg.audioStart === 'number' ? msg.audioStart : null,
              audioEnd: typeof msg.audioEnd === 'number' ? msg.audioEnd : null,
            });
          }
        } catch (err) {
          console.warn('[WhisperLocal] Failed to parse WebSocket message:', err);
        }
      });

      this.ws.on('error', (err) => {
        console.error('[WhisperLocal] WebSocket error:', err.message);
        onStatus('error');
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[WhisperLocal] WebSocket closed: ${code} - ${reason.toString()}`);
        this.isReady = false;
        onStatus('disconnected');
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Local Whisper sidecar connection timed out after 8 seconds'));
        }, 8000);

        this.ws!.once('open', () => {
          clearTimeout(timeout);
          resolve();
        });

        this.ws!.once('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    } catch (err) {
      console.error('[WhisperLocal] Connection initialization failed:', err);
      onStatus('error');
      try { this.ws?.close(); } catch { /* ignore */ }
      this.ws = null;
      throw err;
    }
  }

  sendAudio(data: Buffer): void {
    if (!this.ws || !this.isReady || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(data);
    } catch (err) {
      console.warn('[WhisperLocal] sendAudio block failure:', err);
    }
  }

  async stop(): Promise<void> {
    this.isReady = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch { /* ignore */ }
      this.ws = null;
    }
  }
}
