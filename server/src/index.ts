// ---------------------------------------------------------------------------
// Call Copilot — Backend entry point
//
// Creates:
//   - Express HTTP server (health check + REST endpoints)
//   - WebSocket server (audio streaming + real-time events)
// ---------------------------------------------------------------------------

import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { config } from './config';
import { ClientSocketHandler } from './ws/clientSocket';
import sessionsRouter from './routes/sessions';
import llmLogsRouter from './routes/llmLogs';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', async (_req, res) => {
  type ServiceStatus = 'ready' | 'mock' | 'disabled' | 'error';

  let sidecarOk = false;
  let sidecarDetail: string | null = null;

  if (config.useDiarization) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(
        `${config.diarizationUrl.replace(/\/$/, '')}/health`,
        { signal: controller.signal }
      );
      if (response.ok) {
        sidecarOk = true;
        const body = (await response.json()) as { status?: string };
        if (body.status && body.status !== 'ok') {
          sidecarOk = false;
          sidecarDetail = `sidecar status: ${body.status}`;
        }
      } else {
        sidecarDetail = `sidecar HTTP ${response.status}`;
      }
    } catch (err) {
      sidecarDetail = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
  }

  const diarizationStatus: ServiceStatus = !config.useDiarization
    ? 'disabled'
    : sidecarOk
    ? 'ready'
    : 'error';

  let asrStatus: ServiceStatus;
  let asrProvider: 'mock' | 'deepgram' | 'whisper-local';
  if (config.useMockDeepgram) {
    asrStatus = 'mock';
    asrProvider = 'mock';
  } else if (config.useLocalWhisper) {
    asrProvider = 'whisper-local';
    asrStatus = sidecarOk ? 'ready' : 'error';
  } else {
    asrProvider = 'deepgram';
    asrStatus = config.deepgramApiKey ? 'ready' : 'error';
  }

  const openaiStatus: ServiceStatus = config.useMockOpenAI ? 'mock' : 'ready';

  res.json({
    status: 'ok',
    mockMode: {
      deepgram: config.useMockDeepgram,
      openai: config.useMockOpenAI,
      diarization: !config.useDiarization,
    },
    services: {
      asr: { status: asrStatus, provider: asrProvider },
      openai: { status: openaiStatus },
      diarization: {
        status: diarizationStatus,
        detail: sidecarDetail,
      },
    },
    diarizationUrl: config.diarizationUrl || null,
    timestamp: new Date().toISOString(),
  });
});

app.use('/sessions', sessionsRouter);
app.use('/llm-logs', llmLogsRouter);

app.post('/enroll', express.raw({ type: 'audio/wav', limit: '10mb' }), async (req: express.Request, res: express.Response) => {
  const name = req.query.name as string;
  if (!name || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'Missing name or audio body data' });
  }

  try {
    const url = `${config.diarizationUrl.replace(/\/$/, '')}/enroll?name=${encodeURIComponent(name)}`;
    const formData = new FormData();
    const blob = new Blob([req.body], { type: 'audio/wav' });
    formData.append('audio', blob, 'enroll.wav');

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: `Sidecar error: ${text}` });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: `Failed to enroll voice profile: ${message}` });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/copilot-ws' });

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin ?? 'unknown';
  console.log(`[WS] New connection from ${origin}`);
  new ClientSocketHandler(ws);
});

wss.on('error', (err) => {
  console.error('[WSS] Server error:', err.message);
});

server.listen(config.port, () => {
  console.log(`\nCall Copilot server running on http://localhost:${config.port}`);
  console.log(`   WebSocket: ws://localhost:${config.port}/copilot-ws`);
  console.log(`   Health:    http://localhost:${config.port}/health`);
  console.log(`   Sessions:  http://localhost:${config.port}/sessions`);
  if (config.useMockDeepgram || config.useLocalWhisper || config.useMockOpenAI || !config.useDiarization) {
    console.log('\nConfigured Services:');
    if (config.useMockDeepgram) console.log('   • Transcription -> Mock Generator');
    if (config.useLocalWhisper)  console.log('   • Transcription -> Local Whisper Sidecar');
    if (config.useMockOpenAI)   console.log('   • OpenAI        -> Mock Analysis Responses');
    if (!config.useDiarization) console.log('   • Diarization   -> disabled (no DIARIZATION_URL)');
  }
  if (config.useDiarization) {
    console.log(`   Pyannote:  ${config.diarizationUrl}`);
  }
  console.log('');
});

process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received — shutting down');
  server.close(() => process.exit(0));
});
