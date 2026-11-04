// ---------------------------------------------------------------------------
// REST endpoint for listing and retrieving saved sessions.
// Simple file-based storage — easy to swap for Postgres later.
// ---------------------------------------------------------------------------

import express, { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config';

const router = Router();

// Map raw pyannote labels ("SPEAKER_00", "SPEAKER_01", ...) to the app's
// "Speaker N" convention (1-indexed, in order of first appearance) — the
// same convention DiarizationClient.labelFor() applies for the live
// streaming path. Names already resolved to a voice profile (e.g. "Alice")
// don't match the pattern and pass through unchanged.
function normalizeSpeakerLabels<T extends { speaker: string }>(chunks: T[]): T[] {
  const order: string[] = [];
  return chunks.map((c) => {
    if (!/^SPEAKER_\d+$/i.test(c.speaker)) return c;
    let idx = order.indexOf(c.speaker);
    if (idx === -1) {
      idx = order.length;
      order.push(c.speaker);
    }
    return { ...c, speaker: `Speaker ${idx + 1}` };
  });
}

// GET /sessions — list saved session files
router.get('/', (_req: Request, res: Response) => {
  try {
    const dir = config.sessionDir;
    if (!fs.existsSync(dir)) {
      return res.json({ sessions: [] });
    }
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.autosave.json'))
      .map((f) => {
        const stat = fs.statSync(path.join(dir, f));
        return { id: f.replace('.json', ''), savedAt: stat.mtime };
      })
      .sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime());

    res.json({ sessions: files });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// GET /sessions/:id/autosave/wav — emergency recording (if the server was buffering audio)
router.get('/:id/autosave/wav', (req: Request, res: Response) => {
  try {
    const filePath = path.join(config.sessionDir, `${req.params.id}.autosave.wav`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'No autosave audio for this session' });
    }
    res.setHeader('Content-Type', 'audio/wav');
    res.sendFile(path.resolve(filePath));
  } catch {
    res.status(500).json({ error: 'Failed to read autosave audio' });
  }
});

// GET /sessions/:id/autosave — latest periodic / crash snapshot (if any)
router.get('/:id/autosave', (req: Request, res: Response) => {
  try {
    const filePath = path.join(config.sessionDir, `${req.params.id}.autosave.json`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'No autosave for this session' });
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    res.json(data);
  } catch {
    res.status(500).json({ error: 'Failed to read autosave' });
  }
});

// GET /sessions/:id — retrieve a single session
router.get('/:id', (req: Request, res: Response) => {
  try {
    const filePath = path.join(config.sessionDir, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    res.json(data);
  } catch {
    res.status(500).json({ error: 'Failed to read session' });
  }
});

// POST /sessions/upload — process a WAV/MP3 file and save as a completed session
router.post('/upload', express.raw({ type: '*/*', limit: '50mb' }), async (req: Request, res: Response) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'Missing audio file data in body' });
  }

  const contentType = req.headers['content-type'] ?? 'audio/wav';
  const extension = contentType.includes('mpeg') || contentType.includes('mp3') ? '.mp3' : '.wav';
  const filename = `upload-${Date.now()}${extension}`;

  try {
    const url = `${config.diarizationUrl.replace(/\/$/, '')}/process-file`;
    const formData = new FormData();
    const blob = new Blob([req.body], { type: contentType });
    formData.append('audio', blob, filename);

    console.log(`[Upload] Sending ${req.body.length} bytes to sidecar...`);
    const sidecarRes = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!sidecarRes.ok) {
      const text = await sidecarRes.text();
      return res.status(sidecarRes.status).json({ error: `Sidecar error: ${text}` });
    }

    const json = (await sidecarRes.json()) as {
      transcriptChunks: any[];
      numSpeakers: number;
      duration: number;
    };

    const transcriptChunks = normalizeSpeakerLabels(json.transcriptChunks);

    const sessionId = randomUUID();
    const startedAt = Date.now() - Math.round(json.duration * 1000);
    const endedAt = Date.now();

    const finalTranscript = transcriptChunks
      .map((c) => `${c.speaker}: ${c.text}`)
      .join('\n');

    const sessionPayload = {
      sessionId,
      mode: 'copilot',
      startedAt,
      endedAt,
      finalTranscript,
      transcriptChunks,
      customPrompt: 'Summarize what has been said so far. Note any decisions, action items, or open questions.',
      analysisResults: [],
      speakerAliases: {},
      speakerMerges: {},
      notes: '',
    };

    const filePath = path.join(config.sessionDir, `${sessionId}.json`);
    fs.mkdirSync(config.sessionDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(sessionPayload, null, 2));

    console.log(`[Upload] Saved processed session: ${filePath}`);
    return res.json(sessionPayload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Upload] Error processing file: ${message}`);
    return res.status(500).json({ error: `Failed to process audio file: ${message}` });
  }
});

export default router;
