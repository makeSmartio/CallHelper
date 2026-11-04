# Call Copilot

A real-time AI copilot for your own calls. It listens through your mic,
transcribes speech live, labels who's speaking, and runs a customizable
prompt against the rolling transcript every few seconds.

> Originally cloned from a legal-intake tool; reworked into a generic,
> single-page personal assistant for any kind of conversation.

---

## What it does

- **Live transcription** — Deepgram streaming ASR or local Parakeet MLX over
  your mic audio.
- **Speaker diarization** — local `pyannote.audio` sidecar labels each
  finalized chunk with `Speaker 1`, `Speaker 2`, …. Labels appear live as
  "Speaker ?" and get back-filled every ~10 seconds.
- **Live AI analysis** — your custom prompt runs against the rolling
  transcript every ~3 seconds (or on demand). Saved-prompt list per device.
- **Entire-call summaries** — hierarchical section summaries capture the full
  transcript, then synthesize decisions, action items, open questions, and
  follow-ups.
- **Local-first** — diarization runs on your machine. Transcripts and
  analysis results live in `server/data/`.
- **Mock mode** — the whole UI works without any API keys, with a generic
  sample conversation.

---

## Prerequisites

- Node.js ≥ 18 and npm ≥ 9
- Python ≥ 3.10 (for diarization or local transcription)
- Apple Silicon (only if you want the local Parakeet MLX transcription
  fallback)
- Optional API keys:
  - [Deepgram](https://console.deepgram.com/) — live transcription
  - [OpenAI](https://platform.openai.com/) — analysis prompt
  - [Hugging Face](https://hf.co/settings/tokens) — to download the
    pyannote model

Without keys you get mock transcripts + mock analysis (UI fully usable).
Without the HF token / Python venv, diarization is disabled and the
transcript just shows "Speaker ?".

---

## Install

```bash
./start.sh --install
```

This installs `server/`, `client/`, and (if Python is available) creates
`server/diarization/.venv` with `pyannote.audio`.

### Hugging Face setup (one-time, for diarization)

1. Sign in at <https://huggingface.co/>.
2. Generate a read-only token: <https://hf.co/settings/tokens>.
3. Accept the model terms on
   <https://hf.co/pyannote/speaker-diarization-3.1> (one button click).

---

## Configure

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

Those copies are gitignored. The committed examples use empty keys. The
committed examples use empty keys. Do not commit `.git_bad/`, session
files, or audio under `server/data/`.

`server/.env`:

```env
PORT=3001
DEEPGRAM_API_KEY=...
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-terra
ANTHROPIC_API_KEY=...
XAI_API_KEY=...

# Pyannote sidecar
DIARIZATION_URL=http://127.0.0.1:8765
HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxx
DIARIZATION_INTERVAL_MS=10000

# Optional local ASR model, used when DEEPGRAM_API_KEY is absent
PARAKEET_MODEL=mlx-community/parakeet-tdt-0.6b-v2
```

### API keys

Enter keys in the page. On first load, if a key is missing, a dialog asks for
Deepgram, OpenAI, Anthropic, xAI, and Hugging Face keys. Click **Keys** in the
header to change them. Keys are saved in this browser's `localStorage` and
sent to the local server, which holds them in memory. Blank fields keep their
current setting.

`server/.env` still works as a fallback. A key set there is used when the
browser has no value for it. Nothing is written back to `.env`.

Speaker diarization needs both `DIARIZATION_URL` and a Hugging Face token. The
pyannote model loads only after a token is present, so the app runs without
it. The sidecar must be restarted once after pulling this change so it serves
the `/token` endpoint.

`client/.env`:

Leave `VITE_WS_URL` unset while using Vite. The page connects to
same-origin `/copilot-ws`, and Vite proxies that to `PORT` from
`server/.env`. A bare `ws://localhost:3001` does not connect.

---

## Run

```bash
./start.sh
```

This boots three processes in one terminal:

1. **Python pyannote sidecar** on port 8765 (skipped if its venv
   doesn't exist).
2. **Node backend** on port 3001.
3. **Vite dev server** on port 5173.

`start.sh` binds all three on `0.0.0.0` (every network interface). Open
<http://localhost:5173>, click **Start**, and grant the mic. Do not
port-forward these ports to the internet; the server has no auth.

The first call after a cold start takes a few extra seconds because
pyannote downloads + loads the model. Subsequent calls reuse the loaded
pipeline.

---

## Usage notes

- The **prompt** in the top bar is what the AI does on every analysis tick.
  Edit it freely; saved prompts persist in `localStorage`.
- **Pause analysis** keeps transcription + diarization running but stops
  spending OpenAI tokens.
- **Run Now** forces an immediate analysis pass.
- **Summarize Entire Call** processes the complete transcript instead of the
  rolling 3,000-character live-analysis window. Choose GPT-5.6 Terra, Sol, or
  Luna from the model menu to trade off quality, speed, and cost.
- During silence (≥ 3 s) the client auto-triggers one analysis pass so the
  copilot "catches up" at natural breaks.
- **↓ Export** writes the current session (transcript + analysis + LLM
  log) to a JSON file you can re-load with **↑ Import**.
- **↓ WAV** downloads the raw audio you streamed during this session,
  handy for offline pyannote experiments.

---

## Architecture

```
Browser (React + Vite)            Node backend (Express + ws)            Python sidecar (FastAPI)
  │                                  │                                       │
  │  PCM16 @ 16 kHz over WS (binary) │                                       │
  ├─────────────────────────────────►│                                       │
  │                                  │  → Deepgram Listen v1 (cloud ASR)     │
  │                                  │  → Parakeet MLX (local ASR fallback)  │
  │                                  │  → pyannote.audio every ~10s ────────►│
  │                                  │                                       │  loads
  │                                  │  ← speaker segments  ←────────────────│  pyannote/
  │  transcript + speaker labels     │  → OpenAI on rolling transcript       │  speaker-
  │◄─────────────────────────────────│                                       │  diarization-3.1
```

| Tier | Port | Tech |
| --- | --- | --- |
| Frontend | 5173 | React + Vite + Tailwind |
| Backend  | 3001 | Node 18+, Express, `ws`, OpenAI SDK, Deepgram SDK |
| Diarization | 8765 | Python 3.10+, FastAPI, `pyannote.audio`, PyTorch |

Periodic diarization covers the last `DIARIZATION_WINDOW_SECONDS` of audio
(default 120 s) every `DIARIZATION_INTERVAL_MS` (default 10 s). Speaker
identity is carried across windows with embeddings. The end-of-session pass
still uses the full recording.

---

## File layout

```
CallHelper/
├── LICENSE                     # MIT
├── README.md
├── start.sh                    # boots all 3 processes
├── package.json                # convenience root scripts
│
├── client/                     # React + Vite frontend
│   └── src/
│       ├── App.tsx
│       ├── main.tsx
│       ├── pages/CopilotPage.tsx
│       ├── components/
│       │   ├── TranscriptPanel.tsx
│       │   └── StatusBadge.tsx
│       └── lib/
│           ├── types.ts
│           └── ws.ts
│
└── server/                     # Node + Python backend
    ├── src/
    │   ├── index.ts            # Express + WS entry point
    │   ├── config/index.ts
    │   ├── lib/
    │   │   ├── audioBuffer.ts      # accumulates PCM, wraps as WAV
    │   │   ├── transcriptBuffer.ts # transcript chunks + speaker labels
    │   │   └── llmLog.ts           # SQLite log of every OpenAI call
    │   ├── services/
    │   │   ├── deepgram.ts         # ASR (+ mock)
    │   │   └── diarization.ts      # client for the pyannote sidecar
    │   ├── routes/
    │   │   ├── sessions.ts
    │   │   └── llmLogs.ts
    │   └── ws/clientSocket.ts      # per-client orchestrator
    │
    ├── diarization/            # Python pyannote sidecar (FastAPI)
    │   ├── service.py
    │   ├── requirements.txt
    │   └── README.md
    │
    └── data/                   # gitignored — sessions + LLM call log
```

---

## API endpoints (Node backend)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | service status + mock flags + diarization URL |
| `GET` | `/sessions` | list saved sessions |
| `GET` | `/sessions/:id` | fetch one session |
| `GET` | `/llm-logs?sessionId=…` | LLM call log (SQLite-backed) |
| `WS`  | `/copilot-ws` | audio stream + control messages |

---

## Limitations

- **Mic only.** This captures only your microphone — to label the other
  side of a Zoom/Meet/phone call you'd need to route system audio into the
  mic (BlackHole on macOS, VB-CABLE on Windows). Adding a system-audio
  capture path is a sensible next step.
- **No streaming pyannote.** Periodic passes re-diarize the last
  `DIARIZATION_WINDOW_SECONDS` (default 120 s). The final pass still
  processes the whole recording, so very long calls cost more at hang-up.
  For true streaming, swap in [`diart`](https://github.com/juanmc2005/diart).
- **No auth / encryption.** Local dev tool only. Don't expose the server
  port to the internet without putting auth + TLS in front of it. Keys
  entered in the page are stored in plain text in browser `localStorage`, and
  `POST /keys` accepts keys without auth.
- **Recording consent.** Many jurisdictions require all-party consent to
  record. Add a consent banner before deploying this anywhere shared.

---

## Troubleshooting

- **Diarization disabled / Diar badge says "Offline":**
  - Is `DIARIZATION_URL` set in `server/.env`?
  - Is `server/diarization/.venv` present? Run `./start.sh --install`.
  - Did you accept the model terms and add a Hugging Face key in **Keys** (or set `HF_TOKEN` in `server/.env`)?
  - Try `curl http://127.0.0.1:8765/health` to confirm the sidecar is up.
- **Pyannote slow on the first run:** the model is being downloaded and
  loaded. Watch the diarization terminal for "Pipeline ready".
- **`ASR` badge stuck on "Connecting":** check `DEEPGRAM_API_KEY` and your
  internet connection. Without `DEEPGRAM_API_KEY`, verify that the sidecar is
  running on Apple Silicon and that its Parakeet model can be downloaded.
- **`AI` badge stays "Offline":** add an OpenAI key in **Keys**, or set `OPENAI_API_KEY` in `server/.env`.
  Without a key, the analysis falls back to mock responses.

---

## Roadmap

1. System-audio capture (BlackHole / WASAPI loopback) so both sides of a
   call get diarized.
2. Streaming diarization via [`diart`](https://github.com/juanmc2005/diart).
3. Per-speaker enrollment ("This is me") so labels are "Me / Jane / …"
   instead of "Speaker 1 / Speaker 2".
4. Session history UI with playback.
5. Persistent project / context — let the copilot remember names and
   topics across calls.

---

## License

[MIT](LICENSE). Copyright (c) 2026 makeSmartio.
