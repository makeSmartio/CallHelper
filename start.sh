#!/usr/bin/env bash
# Run the Call Copilot stack from one terminal:
#   - Python pyannote diarization sidecar (if its venv exists)
#   - Node backend (Express + WebSocket)
#   - Vite dev server (React frontend)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$ROOT"

DIAR_VENV="$ROOT/server/diarization/.venv"
DIAR_PYTHON="$DIAR_VENV/bin/python"
DIAR_IMPORT_ERROR=""

# Supported range for the sidecar: Python 3.11 through 3.13.
# - Below 3.11: SciPy 1.15.x (the last release that supports 3.10) ships a
#   _spropack wheel that dyld on macOS 26+ rejects. SciPy 1.16+ needs 3.11+.
# - 3.14+: torch==2.8.0 (pinned for pyannote.audio 3.3.2) has no 3.14 wheels.
DIAR_PY_MIN_MINOR=11
DIAR_PY_MAX_MINOR=13

# Prefer an explicitly versioned interpreter over `python3`, which may be a
# pyenv 3.10 or a Homebrew 3.14.
resolve_diar_python() {
  local cand minor
  for cand in python3.12 python3.13 python3.11 python3; do
    if command -v "$cand" >/dev/null 2>&1; then
      minor="$(diar_python_minor "$cand")"
      if [[ "$minor" -ge "$DIAR_PY_MIN_MINOR" && "$minor" -le "$DIAR_PY_MAX_MINOR" ]]; then
        printf '%s\n' "$cand"
        return 0
      fi
    fi
  done
  return 1
}

diar_python_minor() {
  local bin="$1"
  "$bin" -c "import sys; print(sys.version_info.minor)" 2>/dev/null || echo 0
}

# A venv is not relocatable: its activate script and shebangs hardcode the
# absolute path it was created at. If this repo was ever moved/renamed, a
# pre-existing .venv here will silently point at a path that no longer
# exists. Detect that by invoking the venv's python binary directly (not
# via `source activate`, which can mask the failure behind a pyenv shim).
# Also fail if pyannote.audio cannot import (e.g. SciPy wheel vs OS).
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
  DIAR_PY="$(resolve_diar_python || true)"
  if [[ -z "$DIAR_PY" ]]; then
    found="$(python3 --version 2>&1 || echo 'no python3 on PATH')"
    echo "The pyannote sidecar needs Python 3.$DIAR_PY_MIN_MINOR-3.$DIAR_PY_MAX_MINOR (found: $found)." >&2
    echo "Install one, e.g. 'brew install python@3.12', then re-run $0 --install." >&2
    exit 1
  fi
  recreate=0
  if [[ -d "$DIAR_VENV" ]] && ! diar_venv_is_healthy; then
    echo ""
    echo "Existing Python venv at server/diarization/.venv cannot import pyannote:"
    echo "  ${DIAR_IMPORT_ERROR:-unknown import error}"
    echo "Recreating with $DIAR_PY..."
    recreate=1
  elif [[ -x "$DIAR_PYTHON" ]]; then
    venv_minor="$(diar_python_minor "$DIAR_PYTHON")"
    if [[ "$venv_minor" -lt "$DIAR_PY_MIN_MINOR" || "$venv_minor" -gt "$DIAR_PY_MAX_MINOR" ]]; then
      echo ""
      echo "Existing Python venv is 3.$venv_minor (supported: 3.$DIAR_PY_MIN_MINOR-3.$DIAR_PY_MAX_MINOR). Recreating with $DIAR_PY..."
      recreate=1
    fi
  fi
  if [[ "$recreate" -eq 1 ]]; then
    rm -rf "$DIAR_VENV"
  fi
  if [[ ! -d "$DIAR_VENV" ]]; then
    echo ""
    echo "Setting up Python venv for the pyannote sidecar with $DIAR_PY..."
    "$DIAR_PY" -m venv "$DIAR_VENV"
    "$DIAR_PYTHON" -m pip install --upgrade pip
    "$DIAR_PYTHON" -m pip install -r server/diarization/requirements.txt
    if ! diar_venv_is_healthy; then
      echo "Diarization venv installed but import still fails:" >&2
      echo "  ${DIAR_IMPORT_ERROR:-unknown import error}" >&2
      exit 1
    fi
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
if [[ -d "$DIAR_VENV" ]] && diar_venv_is_healthy; then
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
elif [[ ! -d "$DIAR_VENV" ]]; then
  echo "Pyannote sidecar venv not found at server/diarization/.venv"
  echo "  Diarization will be disabled. Run: $0 --install  to set it up."
else
  echo "Pyannote sidecar venv at server/diarization/.venv failed to import:"
  echo "  ${DIAR_IMPORT_ERROR:-unknown import error}"
  echo "  Diarization will be disabled. If this is a SciPy/macOS wheel issue, use Python 3.12:"
  echo "  rm -rf server/diarization/.venv && $0 --install"
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
