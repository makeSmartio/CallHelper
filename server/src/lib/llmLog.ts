import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface LlmLogEntry {
  id?: number;
  sessionId: string;
  mode: string;
  timestamp: number;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
}

const dbDir = path.resolve(__dirname, '../../../data');
const dbPath = path.join(dbDir, 'llm_calls.db');

fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS llm_calls (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       TEXT    NOT NULL,
    mode             TEXT    NOT NULL,
    timestamp        INTEGER NOT NULL,
    model            TEXT    NOT NULL,
    system_prompt    TEXT    NOT NULL,
    user_prompt      TEXT    NOT NULL,
    response         TEXT    NOT NULL,
    prompt_tokens    INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens     INTEGER NOT NULL DEFAULT 0,
    duration_ms      INTEGER NOT NULL DEFAULT 0
  )
`);

const insertStmt = db.prepare(`
  INSERT INTO llm_calls
    (session_id, mode, timestamp, model, system_prompt, user_prompt, response,
     prompt_tokens, completion_tokens, total_tokens, duration_ms)
  VALUES
    (@sessionId, @mode, @timestamp, @model, @systemPrompt, @userPrompt, @response,
     @promptTokens, @completionTokens, @totalTokens, @durationMs)
`);

const selectAllStmt = db.prepare(`
  SELECT * FROM llm_calls ORDER BY id DESC
`);

const selectBySessionStmt = db.prepare(`
  SELECT * FROM llm_calls WHERE session_id = ? ORDER BY id DESC
`);

export function logLlmCall(entry: Omit<LlmLogEntry, 'id'>): LlmLogEntry {
  try {
    const info = insertStmt.run(entry);
    return { ...entry, id: info.lastInsertRowid as number };
  } catch (err) {
    console.error('[LlmLog] Failed to write log entry:', err);
    return entry;
  }
}

export function getLlmLogs(sessionId?: string): LlmLogEntry[] {
  try {
    const rows = sessionId
      ? (selectBySessionStmt.all(sessionId) as Record<string, unknown>[])
      : (selectAllStmt.all() as Record<string, unknown>[]);

    return rows.map((r) => ({
      id: r.id as number,
      sessionId: r.session_id as string,
      mode: r.mode as string,
      timestamp: r.timestamp as number,
      model: r.model as string,
      systemPrompt: r.system_prompt as string,
      userPrompt: r.user_prompt as string,
      response: r.response as string,
      promptTokens: r.prompt_tokens as number,
      completionTokens: r.completion_tokens as number,
      totalTokens: r.total_tokens as number,
      durationMs: r.duration_ms as number,
    }));
  } catch (err) {
    console.error('[LlmLog] Failed to query log entries:', err);
    return [];
  }
}
