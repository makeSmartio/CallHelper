# Pyannote diarization sidecar

A small FastAPI service that wraps
[`pyannote/speaker-diarization-3.1`](https://hf.co/pyannote/speaker-diarization-3.1)
for diarization and Parakeet MLX for local transcription.

```
Node backend  ──HTTP POST /diarize (WAV)──►  Python (FastAPI + pyannote)
              ◄──JSON {segments, …}────────
Node backend  ──WS /stream-transcribe (PCM)► Python (FastAPI + Parakeet MLX)
              ◄──JSON {text, isFinal, …}────
```

## One-time setup

1. Create an account on [Hugging Face](https://huggingface.co/) and generate a
   read-only access token: <https://hf.co/settings/tokens>
2. Accept the gated-model terms for
   <https://hf.co/pyannote/speaker-diarization-3.1>
   (a single "Agree and access repository" click).
3. Install Python deps with [uv](https://docs.astral.sh/uv/). It reads
   `.python-version` (3.14), fetches that Python if needed, and installs the
   exact versions in `uv.lock` into `.venv`:

   ```bash
   cd server/diarization
   uv sync --locked
   ```

   To change dependencies, edit `pyproject.toml` (or use `uv add` /
   `uv remove`) and commit the updated `uv.lock`. `uv lock --upgrade`
   moves everything to the newest compatible versions.

4. Put the token in `server/.env` (`./start.sh --install` offers to do this):

   ```
   HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxx
   ```

## Run

```bash
cd server/diarization
uv run service.py   # loads ../.env (server/.env) via python-dotenv
```

`start.sh` at the repo root does this for you when `server/diarization/.venv`
exists.

The local transcription engine requires Apple Silicon. It downloads
`mlx-community/parakeet-tdt-0.6b-v2` on its first use; set `PARAKEET_MODEL`
to use a different compatible Parakeet MLX model.

Health check: <http://127.0.0.1:8765/health>

## Memory usage

Both pyannote (`/diarize`, `/process-file`) and Parakeet MLX
(`/stream-transcribe`) run on the GPU's unified memory on Apple Silicon, and
neither framework's allocator caches are returned to the OS on their own:

- `/diarize`'s periodic caller (the Node backend's diarization loop) only
  sends a trailing window of session audio — `DIARIZATION_WINDOW_SECONDS`
  (default 120s) — instead of the whole growing session, so each pass's
  working set is bounded independent of how long the call has run. Only the
  one-shot final pass at session end (and `/process-file`) processes the
  full audio. The service still explicitly calls `torch.mps.empty_cache()`
  (`torch.cuda.empty_cache()` on CUDA) after every diarization pass so freed
  blocks are returned to the OS between passes — worth keeping even with
  windowing, since MPS still won't return blocks to the OS on its own.
- MLX's own free-buffer cache defaults to its memory limit (effectively
  unbounded). It's capped via `mx.set_cache_limit(...)` at startup — override
  with `MLX_CACHE_LIMIT_MB` in `server/.env` (default `512`) — and explicitly
  cleared with `mx.clear_cache()` when a streaming session ends or a file
  finishes transcribing.

`DIARIZATION_INTERVAL_MS` (how often periodic passes run) and
`DIARIZATION_WINDOW_SECONDS` (how much trailing audio each pass reprocesses)
are independent knobs, set in `server/.env` and read by the Node backend. If
you still see memory climb over a very long call, try lowering
`DIARIZATION_WINDOW_SECONDS`, or restarting the sidecar between long
sessions.

## API

### `POST /diarize`

Multipart form:
- `audio` — 16 kHz mono PCM16 WAV bytes (required). May be the whole
  session or just a trailing window of it — the sidecar has no notion of
  "session" and always diarizes exactly the bytes it's given.
- `known_speakers` — optional JSON-encoded string,
  `[{"label": "Speaker 2", "embedding": [...]}, ...]`. Voice embeddings the
  caller wants matched against this pass's detected clusters (e.g. Node's
  per-session running centroids, used so a speaker keeps their label after
  their earlier audio has scrolled out of a windowed pass). Checked after
  named `/enroll` profiles, which always take priority. Omit or send `[]`
  for identical behavior to profile-matching alone.

Response:

```json
{
  "segments": [
    {"start": 0.00, "end": 2.31, "speaker": "SPEAKER_00"},
    {"start": 2.31, "end": 4.95, "speaker": "SPEAKER_01"}
  ],
  "duration": 4.95,
  "num_speakers": 2,
  "took_ms": 412,
  "speaker_embeddings": {
    "SPEAKER_00": [0.01, -0.02, ...],
    "SPEAKER_01": [0.03, 0.04, ...]
  }
}
```

A segment's `speaker` is a named profile (e.g. `"Alice"`) or a
`known_speakers` label if the cluster matched one, otherwise pyannote's raw
cluster ID (e.g. `"SPEAKER_00"`) — the Node side mints stable "Speaker 1",
"Speaker 2", … labels for whatever comes back unresolved. `speaker_embeddings`
gives the voice embedding computed for each resolved/raw label in this pass,
so callers can seed or update their own per-speaker centroids for the next
`known_speakers` round-trip. Segment times are relative to the `audio` bytes
given, not the whole session — callers windowing their audio need to offset
them back to session-absolute time themselves.

### `WS /stream-transcribe`

Receives binary 16 kHz mono PCM16 audio frames and returns JSON messages with
`text`, `isFinal`, `audioStart`, and `audioEnd`. It uses Parakeet MLX's
streaming API and keeps the WebSocket contract used by the Node backend
unchanged.

### `POST /process-file`

Receives a WAV or MP3 upload and returns Parakeet MLX sentence timestamps
aligned with pyannote speaker segments.
