import { Router, Request, Response } from 'express';
import { getLlmLogs } from '../lib/llmLog';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
  const logs = getLlmLogs(sessionId);
  res.json({ logs, count: logs.length });
});

export default router;
