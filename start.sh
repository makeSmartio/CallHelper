#!/usr/bin/env bash
# Run the Call Copilot stack from one terminal:
#   - Python pyannote diarization sidecar (if its venv exists)
#   - Node backend (Express + WebSocket)
#   - Vite dev server (React frontend)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$ROOT"

DIAR_DIR="$ROOT/server/diarization"
DIAR_PYTHON="$DIAR_DIR/.venv/bin/python"
DIAR_IMPORT_ERROR=""

# uv owns the sidecar's Python (3.14, from server/diarization/.python-version)
# and its venv. An unrelated activated venv would make uv warn and is never
# what we want here.
unset VIRTUAL_ENV

# Fail if the venv's python is missing or cannot import the sidecar's deps.
# Invoke it directly rather than through `source activate`, which can hide a
# broken venv behind a pyenv shim.
diar_venv_is_healthy() {
  DIAR_IMPORT_ERROR=""
  if [[ ! -x "$DIAR_PYTHON" ]]; then
    DIAR_IMPORT_ERROR="venv python is missing or not executable"
    return 1
  fi
  local err
  if ! err="$("$DIAR_PYTHON" -c "import numpy, fastapi, pyannote.audio" 2>&1)"; then
    DIAR_IMPORT_ERROR="$(printf '%s\n' "$err" | grep -E '^(ImportError|ModuleNotFoundError)' | tail -1 || true)"
    if [[ -z "$DIAR_IMPORT_ERROR" ]]; then
      DIAR_IMPORT_ERROR="$(printf '%s\n' "$err" | tail -1 || true)"
    fi
    return 1
  fi
  return 0
}

# Prints the offending process (if any) and the commands to inspect/kill it.
# Returns 1 if the port is occupied, 0 if free or unknown (lsof missing).
require_port_free() {
  local port="$1" label="$2"
  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi
  local info
  info="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$info" ]]; then
    echo "" >&2
    echo "Port $port ($label) is already in use:" >&2
    echo "$info" >&2
    echo "" >&2
    echo "  Find it again:  lsof -nP -iTCP:$port -sTCP:LISTEN" >&2
    echo "  Kill it:        kill <PID>        (or: kill -9 <PID>)" >&2
    return 1
  fi
  return 0
}

if [[ "${1:-}" == "--install" || "${1:-}" == "-i" ]]; then
  (cd server && npm install)
  (cd client && npm install)
  if ! command -v uv >/dev/null 2>&1; then
    echo "uv is required for the pyannote sidecar. Install it with 'brew install uv'" >&2
    echo "(or see https://docs.astral.sh/uv/), then re-run $0 --install." >&2
    exit 1
  fi
  echo ""
  echo "Syncing the pyannote sidecar's Python environment with uv..."
  # --locked: install exactly what uv.lock pins, and fail if pyproject.toml
  # changed without re-running `uv lock`. uv fetches Python 3.14 if needed and
  # rebuilds .venv if it was made with another interpreter.
  uv sync --locked --project "$DIAR_DIR"
  if ! diar_venv_is_healthy; then
    echo "Diarization venv installed but import still fails:" >&2
    echo "  ${DIAR_IMPORT_ERROR:-unknown import error}" >&2
    exit 1
  fi
fi

if [[ ! -d server/node_modules ]]; then
  echo "server/node_modules missing. Run: $0 --install" >&2
  exit 1
fi
if [[ ! -d client/node_modules ]]; then
  echo "client/node_modules missing. Run: $0 --install" >&2
  exit 1
fi

# Source server/.env if present so HF_TOKEN flows into the Python sidecar.
if [[ -f server/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  . server/.env
  set +a
fi

DIAR_SHOULD_START=0
if [[ -d "$DIAR_DIR/.venv" ]] && diar_venv_is_healthy; then
  DIAR_SHOULD_START=1
fi

PORTS_OK=1
require_port_free "${PORT:-3001}" "backend (PORT)" || PORTS_OK=0
require_port_free "${CLIENT_PORT:-5173}" "client/vite (CLIENT_PORT)" || PORTS_OK=0
if [[ "$DIAR_SHOULD_START" -eq 1 ]]; then
  require_port_free "${DIARIZATION_PORT:-8765}" "diarization sidecar (DIARIZATION_PORT)" || PORTS_OK=0
fi
if [[ "$PORTS_OK" -eq 0 ]]; then
  echo "" >&2
  echo "Refusing to start: free the port(s) above, or override PORT/CLIENT_PORT/DIARIZATION_PORT in server/.env, then re-run $0." >&2
  exit 1
fi

SERVER_PID=""
CLIENT_PID=""
DIAR_PID=""

cleanup() {
  for pid in "$SERVER_PID" "$CLIENT_PID" "$DIAR_PID"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
}

trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# 1. Python diarization sidecar (optional)
if [[ "$DIAR_SHOULD_START" -eq 1 ]]; then
  (
    cd server/diarization
    exec "$DIAR_PYTHON" service.py
  ) &
  DIAR_PID=$!
  echo "Pyannote diarization sidecar starting (PID $DIAR_PID, http://0.0.0.0:${DIARIZATION_PORT:-8765})"
elif [[ ! -d "$DIAR_DIR/.venv" ]]; then
  echo "Pyannote sidecar venv not found at server/diarization/.venv"
  echo "  Diarization will be disabled. Run: $0 --install  to set it up."
else
  echo "Pyannote sidecar venv at server/diarization/.venv failed to import:"
  echo "  ${DIAR_IMPORT_ERROR:-unknown import error}"
  echo "  Diarization will be disabled. Run: $0 --install  to resync it with uv."
fi

# 2. Node backend
( cd server && exec npm run dev ) &
SERVER_PID=$!

# 3. Vite frontend.
# Vite treats PORT as its own listen port. server/.env PORT is the backend,
# so drop it in this process and pass it as BACKEND_PORT for the proxy.
(
  cd client
  backend_port="${PORT:-3001}"
  client_port="${CLIENT_PORT:-5173}"
  unset PORT
  export BACKEND_PORT="$backend_port"
  export CLIENT_PORT="$client_port"
  exec npm run dev
) &
CLIENT_PID=$!

echo ""
echo "Call Copilot:"
echo "  server PID $SERVER_PID  ->  http://0.0.0.0:${PORT:-3001}"
echo "  client PID $CLIENT_PID  ->  http://0.0.0.0:${CLIENT_PORT:-5173}"
if [[ -n "$DIAR_PID" ]]; then
  echo "  diar   PID $DIAR_PID   ->  http://0.0.0.0:${DIARIZATION_PORT:-8765}"
fi
echo ""
echo "Press Ctrl+C to stop."
echo ""

while kill -0 "$SERVER_PID" 2>/dev/null && kill -0 "$CLIENT_PID" 2>/dev/null; do
  sleep 0.3
done
cleanup
