// ---------------------------------------------------------------------------
// WebSocket client — manages the connection to the backend.
//
// Audio is sent as raw ArrayBuffer (binary frames).
// Control messages and server events are JSON text frames.
// ---------------------------------------------------------------------------

import { ServerMessage, ClientMessage } from './types';

const WS_PATH = '/copilot-ws';

function withCopilotPath(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '/' || parsed.pathname === '') {
      parsed.pathname = WS_PATH;
    }
    return parsed.toString();
  } catch {
    return url.endsWith(WS_PATH) ? url : `${url.replace(/\/$/, '')}${WS_PATH}`;
  }
}

function wsUrlCandidates(): string[] {
  const urls: string[] = [];
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    urls.push(`${proto}//${window.location.host}${WS_PATH}`);
    const backendPort = import.meta.env.VITE_BACKEND_PORT as string | undefined;
    if (backendPort && window.location.port !== String(backendPort)) {
      urls.push(`${proto}//${window.location.hostname}:${backendPort}${WS_PATH}`);
    }
  }
  const override = import.meta.env.VITE_WS_URL as string | undefined;
  if (override) {
    urls.push(withCopilotPath(override));
  }
  return [...new Set(urls)];
}

type MessageHandler = (msg: ServerMessage) => void;
type StateChangeHandler = (connected: boolean) => void;

export class WSClient {
  private ws: WebSocket | null = null;
  private messageHandlers = new Set<MessageHandler>();
  private stateHandlers = new Set<StateChangeHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private urlIndex = 0;
  private shouldReconnect = true;
  private connectPromise: Promise<void> | null = null;
  private opened = false;

  // Connect to the backend. Safe to call multiple times — returns immediately
  // if already connected or if a connection attempt is in progress.
  connect(): Promise<void> {
    this.shouldReconnect = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      const existing = this.ws;
      const p = new Promise<void>((resolve, reject) => {
        const origOpen = existing.onopen;
        const origError = existing.onerror;
        existing.onopen = (e) => {
          origOpen?.call(existing, e as Event);
          resolve();
        };
        existing.onerror = (e) => {
          origError?.call(existing, e);
          reject(new Error('WebSocket connection failed'));
        };
      });
      this.connectPromise = p;
      void p.finally(() => {
        if (this.connectPromise === p) this.connectPromise = null;
      });
      return p;
    }

    const urls = wsUrlCandidates();
    const url = urls[this.urlIndex % urls.length];
    const p = new Promise<void>((resolve, reject) => {
      try {
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        this.opened = false;

        ws.onopen = () => {
          console.log(`[WS] Connected to backend (${url})`);
          this.opened = true;
          this.reconnectAttempt = 0;
          this.stateHandlers.forEach((h) => h(true));
          resolve();
        };

        ws.onerror = (event) => {
          console.error(`[WS] Connection error (${url})`, event);
          reject(new Error('WebSocket connection failed'));
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string) as ServerMessage;
            this.messageHandlers.forEach((h) => h(msg));
          } catch (e) {
            console.warn('[WS] Failed to parse message', e);
          }
        };

        ws.onclose = (event) => {
          console.log(`[WS] Disconnected (code: ${event.code}) from ${url}`);
          if (this.ws === ws) {
            this.ws = null;
            if (this.opened) {
              this.stateHandlers.forEach((h) => h(false));
            }
            this.opened = false;
            this.urlIndex = (this.urlIndex + 1) % Math.max(urls.length, 1);
            this.scheduleReconnect();
          }
        };
      } catch (e) {
        reject(e);
      }
    });
    this.connectPromise = p;
    void p.finally(() => {
      if (this.connectPromise === p) this.connectPromise = null;
    });
    return p;
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer !== null) return;
    const candidateCount = wsUrlCandidates().length;
    const delay =
      this.reconnectAttempt < candidateCount
        ? 0
        : Math.min(8000, 400 * 2 ** (this.reconnectAttempt - candidateCount));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
  }

  sendJSON(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.warn(
        `[WS] Tried to send JSON while not connected (readyState=${this.ws?.readyState ?? 'none'})`
      );
    }
  }

  sendAudio(buffer: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(buffer);
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStateChange(handler: StateChangeHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export const wsClient = new WSClient();

// ---------------------------------------------------------------------------
// Audio capture — uses Web Audio API to stream PCM Int16 at 16kHz.
//
// Uses AudioWorkletNode (runs on a dedicated audio thread) to capture
// Float32 frames and convert them to Int16 before posting to the main thread.
//
// Audio format sent to backend:
//   PCM signed 16-bit little-endian, mono, 16000 Hz
//   This is what Deepgram real-time API expects.
// ---------------------------------------------------------------------------

const TARGET_SAMPLE_RATE = 16000;

export interface AudioCapture {
  stop: () => void;
  deviceId: string;
  deviceLabel: string;
}

export interface AudioCaptureOptions {
  deviceId?: string;
}

export async function startAudioCapture(
  onChunk: (buffer: ArrayBuffer) => void,
  options?: AudioCaptureOptions
): Promise<AudioCapture> {
  const audioConstraints: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    // Request 16kHz — browser may or may not honor this; AudioContext resamples
    sampleRate: TARGET_SAMPLE_RATE,
  };
  if (options?.deviceId) {
    audioConstraints.deviceId = { exact: options.deviceId };
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: audioConstraints,
  });

  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings();
  const deviceId = settings.deviceId ?? options?.deviceId ?? 'default';
  const deviceLabel =
    track.label.trim().length > 0 ? track.label : 'Microphone';

  // AudioContext at 16kHz causes the browser to resample mic input to 16kHz.
  // Chrome may start the context in 'suspended' state — we resume() explicitly.
  const AudioContextClass =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

  const audioContext = new AudioContextClass({ sampleRate: TARGET_SAMPLE_RATE });

  // IMPORTANT: Chrome suspends AudioContext until resume() is called after a user gesture.
  // The getUserMedia approval above counts as a user gesture, so this should resolve quickly.
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  if (audioContext.sampleRate !== TARGET_SAMPLE_RATE) {
    console.warn(
      `[Audio] Requested ${TARGET_SAMPLE_RATE}Hz but got ${audioContext.sampleRate}Hz. ` +
        'The browser resampled; audio will still be sent but Deepgram quality may vary.'
    );
  }
  console.log(`[Audio] AudioContext running at ${audioContext.sampleRate}Hz, state: ${audioContext.state}`);

  await audioContext.audioWorklet.addModule('/pcm-processor.js');

  const source = audioContext.createMediaStreamSource(stream);
  const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');

  workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    onChunk(event.data);
  };

  // Connect graph: source → workletNode → silent gain → destination
  // Connecting to destination keeps the audio graph running in all browsers.
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;

  source.connect(workletNode);
  workletNode.connect(silentGain);
  silentGain.connect(audioContext.destination);

  return {
    deviceId,
    deviceLabel,
    stop: () => {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
      source.disconnect();
      audioContext.close();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}
