"""
Pyannote and Parakeet local AI sidecar.

Exposes:
  - POST /diarize: diarization with speaker profile matching
  - POST /enroll: voiceprint enrollment
  - GET /health: health status
  - WS /stream-transcribe: real-time Parakeet streaming transcription
"""

from __future__ import annotations

import io
import json
import os
import time
import logging
import traceback
import asyncio
import tempfile
from typing import Optional

# ---------------------------------------------------------------------------
# linecache shim — MUST run before pyannote/speechbrain are imported.
# ---------------------------------------------------------------------------
import linecache as _linecache

_orig_getlines = _linecache.getlines


def _safe_getlines(filename, module_globals=None):
    try:
        return _orig_getlines(filename, module_globals)
    except Exception:
        return []


_linecache.getlines = _safe_getlines

import numpy as np
import soundfile as sf
import torch
import mlx.core as mx

# ---------------------------------------------------------------------------
# torch.load weights_only shim — MUST run before pyannote/lightning import.
# ---------------------------------------------------------------------------
_orig_torch_load = torch.load


def _torch_load_compat(*args, **kwargs):
    if kwargs.get("weights_only") is None:
        kwargs["weights_only"] = False
    return _orig_torch_load(*args, **kwargs)


torch.load = _torch_load_compat

from fastapi import Body, FastAPI, File, Form, UploadFile, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pyannote.audio import Pipeline, Model, Inference
from pyannote.audio.pipelines.utils.hook import ProgressHook
from parakeet_mlx import BaseParakeet, StreamingParakeet, from_pretrained

logging.basicConfig(
    level=logging.INFO,
    format="[sidecar] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("sidecar")

HF_TOKEN = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
MODEL_NAME = os.environ.get("PYANNOTE_MODEL", "pyannote/speaker-diarization-3.1")
HOST = os.environ.get("DIARIZATION_HOST", "0.0.0.0")
PORT = int(os.environ.get("DIARIZATION_PORT", "8765"))
PARAKEET_MODEL = os.environ.get(
    "PARAKEET_MODEL", "mlx-community/parakeet-tdt-0.6b-v2"
)
# MLX's free-buffer cache defaults to its memory limit (i.e. effectively
# unbounded), and shares the same unified memory pyannote/MPS uses. Cap it so
# the two frameworks don't both let their caches balloon over a long call.
MLX_CACHE_LIMIT_MB = int(os.environ.get("MLX_CACHE_LIMIT_MB", "512"))
mx.set_cache_limit(MLX_CACHE_LIMIT_MB * 1024 * 1024)

# Cosine-similarity threshold for matching a detected speaker cluster against
# a named voice profile (/enroll) or an in-request known_speakers embedding.
DIAR_MATCH_THRESHOLD = float(os.environ.get("DIAR_MATCH_THRESHOLD", "0.6"))


def _cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def _best_match(
    embedding: np.ndarray, candidates: dict, threshold: float
) -> tuple:
    """Return (best_name, best_sim) if best_sim exceeds threshold, else (None, best_sim)."""
    best_name = None
    best_sim = -1.0
    for name, cand_emb in candidates.items():
        sim = _cosine_sim(embedding, cand_emb)
        if sim > best_sim:
            best_sim = sim
            best_name = name
    if best_sim > threshold:
        return best_name, best_sim
    return None, best_sim


def _pick_device() -> torch.device:
    if torch.cuda.is_available():
        log.info("CUDA available — using cuda")
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        log.info("Apple MPS available — using mps")
        return torch.device("mps")
    log.info("No GPU — using cpu")
    return torch.device("cpu")


class DiarizationService:
    """Wraps the pyannote pipeline. Lazy-loads on first request."""

    def __init__(self) -> None:
        self._pipeline: Optional[Pipeline] = None
        self._device = _pick_device()

    @property
    def pipeline(self) -> Pipeline:
        if self._pipeline is None:
            if not HF_TOKEN:
                raise RuntimeError(
                    "HF_TOKEN environment variable is not set. Get a token at "
                    "https://hf.co/settings/tokens and accept the model terms "
                    f"at https://hf.co/{MODEL_NAME}"
                )
            log.info("Loading pyannote pipeline %s ...", MODEL_NAME)
            t0 = time.time()
            pipeline = Pipeline.from_pretrained(MODEL_NAME, use_auth_token=HF_TOKEN)
            if pipeline is None:
                raise RuntimeError(
                    f"Failed to load {MODEL_NAME}. Check that HF_TOKEN is valid "
                    "and that you accepted the model terms on Hugging Face."
                )
            pipeline.to(self._device)
            self._pipeline = pipeline
            log.info(
                "Pipeline ready on %s in %.1fs", self._device, time.time() - t0
            )
        return self._pipeline

    def _release_gpu_cache(self) -> None:
        if self._device.type == "mps":
            torch.mps.empty_cache()
        elif self._device.type == "cuda":
            torch.cuda.empty_cache()

    def diarize(
        self, wav_bytes: bytes, known_speakers: Optional[list] = None
    ) -> dict:
        audio, sample_rate = sf.read(io.BytesIO(wav_bytes), dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)  # downmix to mono just in case

        duration = float(len(audio) / sample_rate)
        if duration < 0.5:
            return {
                "segments": [
                    {"start": 0.0, "end": duration, "speaker": "SPEAKER_00"}
                ],
                "duration": duration,
                "num_speakers": 1,
                "took_ms": 0,
                "speaker_embeddings": {},
            }

        waveform = torch.from_numpy(audio).unsqueeze(0)
        if self._device.type != "cpu":
            waveform = waveform.to(self._device)

        t0 = time.time()
        with ProgressHook() as hook:
            diarization = self.pipeline(
                {"waveform": waveform, "sample_rate": sample_rate},
                hook=hook,
            )
        took_ms = int((time.time() - t0) * 1000)
        del waveform

        segments = []
        speakers = set()
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            segments.append(
                {
                    "start": float(turn.start),
                    "end": float(turn.end),
                    "speaker": str(speaker),
                }
            )
            speakers.add(speaker)
        del diarization

        # Resolve speakers against named voice profiles (/enroll) first, then
        # against this session's known_speakers (per-session running
        # centroids sent by the caller), so a returning speaker keeps their
        # label even after their earlier audio has scrolled out of whatever
        # window of audio this call was given. Named profiles always win.
        speaker_mapping = {}
        speaker_embeddings: dict = {}
        try:
            profiles = {}
            profiles_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../data/profiles"))
            if os.path.exists(profiles_dir):
                for file in os.listdir(profiles_dir):
                    if file.endswith(".npy"):
                        name = file[:-4]
                        profiles[name] = np.load(os.path.join(profiles_dir, file))

            known = {}
            for item in known_speakers or []:
                try:
                    known[item["label"]] = np.array(item["embedding"], dtype=np.float32)
                except (KeyError, TypeError, ValueError):
                    continue

            for speaker_id in speakers:
                speaker_samples = []
                for seg in segments:
                    if seg["speaker"] == speaker_id:
                        start_sample = int(seg["start"] * sample_rate)
                        end_sample = int(seg["end"] * sample_rate)
                        speaker_samples.append(audio[start_sample:end_sample])

                if not speaker_samples:
                    continue
                speaker_audio = np.concatenate(speaker_samples)
                if len(speaker_audio) < sample_rate * 0.5:
                    continue

                speaker_emb = embedding_service.get_embedding_numpy(speaker_audio, sample_rate)
                resolved_label = speaker_id

                if profiles:
                    name, sim = _best_match(speaker_emb, profiles, DIAR_MATCH_THRESHOLD)
                    if name:
                        speaker_mapping[speaker_id] = name
                        resolved_label = name
                        log.info(f"Mapped speaker {speaker_id} -> profile '{name}' (sim: {sim:.2f})")

                if speaker_id not in speaker_mapping and known:
                    label, sim = _best_match(speaker_emb, known, DIAR_MATCH_THRESHOLD)
                    if label:
                        speaker_mapping[speaker_id] = label
                        resolved_label = label
                        log.info(f"Mapped speaker {speaker_id} -> known '{label}' (sim: {sim:.2f})")

                speaker_embeddings[resolved_label] = speaker_emb
        except Exception as e:
            log.warning("Speaker matching skipped: %s", e)

        # Map speakers in segments
        for seg in segments:
            raw_spk = seg["speaker"]
            if raw_spk in speaker_mapping:
                seg["speaker"] = speaker_mapping[raw_spk]

        # We re-run this pipeline over the whole (growing) session audio every
        # ~10s. MPS's caching allocator never returns freed blocks to the OS
        # on its own, so without this the process's resident memory climbs
        # for the entire duration of the call and is only reclaimed on exit.
        self._release_gpu_cache()

        return {
            "segments": segments,
            "duration": duration,
            "num_speakers": len(speakers),
            "took_ms": took_ms,
            "speaker_embeddings": {k: v.tolist() for k, v in speaker_embeddings.items()},
        }

    def get_embedding(self, wav_bytes: bytes) -> np.ndarray:
        audio, sample_rate = sf.read(io.BytesIO(wav_bytes), dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        return self.get_embedding_numpy(audio, sample_rate)

    def get_embedding_numpy(self, audio: np.ndarray, sample_rate: int) -> np.ndarray:
        waveform = torch.from_numpy(audio).unsqueeze(0).unsqueeze(0)
        pipeline = self.pipeline
        with torch.no_grad():
            emb = pipeline._embedding(waveform)
        return emb[0]

    def diarize_file(self, file_path: str) -> dict:
        audio, sample_rate = sf.read(file_path, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        out_buf = io.BytesIO()
        sf.write(out_buf, audio, sample_rate, format="WAV", subtype="PCM_16")
        return self.diarize(out_buf.getvalue())


class ParakeetService:
    """Lazy-loads the Apple Silicon Parakeet MLX transcription model."""

    def __init__(self) -> None:
        self._model: Optional[BaseParakeet] = None

    @property
    def model(self) -> BaseParakeet:
        if self._model is None:
            log.info("Loading Parakeet MLX model %s ...", PARAKEET_MODEL)
            t0 = time.time()
            self._model = from_pretrained(PARAKEET_MODEL)
            log.info("Parakeet MLX ready in %.1fs", time.time() - t0)
        return self._model


class EmbeddingService:
    """Delegates speaker verification to the already loaded Diarization pipeline."""
    def get_embedding(self, wav_bytes: bytes) -> np.ndarray:
        return service.get_embedding(wav_bytes)

    def get_embedding_numpy(self, audio: np.ndarray, sample_rate: int) -> np.ndarray:
        return service.get_embedding_numpy(audio, sample_rate)


class ParakeetStreamingTranscriber:
    """Maintains a low-latency Parakeet MLX stream for one WebSocket client."""

    def __init__(self, model: BaseParakeet) -> None:
        self.model = model
        self.stream: StreamingParakeet = model.transcribe_stream(
            context_size=(32, 32), depth=1
        )
        self.stream.__enter__()
        self.audio_buffer = bytearray()
        self.sample_rate = 16000
        self.total_samples = 0
        self.finalized_frontier = 0.0
        self.emitted_finalized_tokens = 0

    def add_audio(self, pcm_bytes: bytes) -> None:
        self.audio_buffer.extend(pcm_bytes)

    def close(self) -> None:
        self.stream.__exit__(None, None, None)
        mx.clear_cache()

    def transcribe(self) -> list[dict]:
        # Only the whole-int16-sample prefix is usable; frombuffer() requires
        # an exact multiple of the dtype size, and a lone leftover byte can
        # legitimately arrive between polls.
        usable_bytes = (len(self.audio_buffer) // 2) * 2
        if usable_bytes < int(self.sample_rate * 0.25) * 2:
            return []

        pcm_data = np.frombuffer(self.audio_buffer[:usable_bytes], dtype=np.int16)
        audio_to_transcribe = pcm_data.astype(np.float32) / 32768.0

        self.total_samples += len(audio_to_transcribe)
        batch_start = self.finalized_frontier
        self.stream.add_audio(mx.array(audio_to_transcribe))

        # Drop the bytes we just fed to the stream so the buffer — and the
        # float32 conversion above — stay bounded to ~0.5s of PCM instead of
        # growing (and being fully reconverted) for the entire session.
        del self.audio_buffer[:usable_bytes]

        new_tokens = self.stream.finalized_tokens[self.emitted_finalized_tokens:]
        self.emitted_finalized_tokens = len(self.stream.finalized_tokens)
        results = []

        if new_tokens:
            text = "".join(token.text for token in new_tokens).strip()
            if text:
                results.append({
                    "text": text,
                    "isFinal": True,
                    "audioStart": batch_start + min(token.start for token in new_tokens),
                    "audioEnd": batch_start + max(token.end for token in new_tokens),
                })

        right_context_seconds = self.stream.context_size[1] * self.model.time_ratio
        self.finalized_frontier = max(
            self.finalized_frontier,
            self.total_samples / self.sample_rate - right_context_seconds,
        )

        draft_text = "".join(token.text for token in self.stream.draft_tokens).strip()
        if draft_text:
            results.append({
                "text": draft_text,
                "isFinal": False,
                "audioStart": self.finalized_frontier,
                "audioEnd": self.total_samples / self.sample_rate,
            })

        return results


service = DiarizationService()
parakeet_service = ParakeetService()
embedding_service = EmbeddingService()

app = FastAPI(title="Local AI Sidecar", version="1.0.0")


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "pyannote_model": MODEL_NAME,
        "device": str(service._device),
        "diarization_loaded": service._pipeline is not None,
        "parakeet_model": PARAKEET_MODEL,
        "parakeet_loaded": parakeet_service._model is not None,
        "embedding_loaded": service._pipeline is not None,
        "has_token": bool(HF_TOKEN),
    }


@app.post("/token")
def set_token_endpoint(payload: dict = Body(...)) -> JSONResponse:
    global HF_TOKEN
    token = str(payload.get("token", "")).strip()
    if not token:
        raise HTTPException(status_code=400, detail="token is required")
    if token == HF_TOKEN:
        return JSONResponse({"status": "unchanged"})
    HF_TOKEN = token
    # Drop the loaded pipeline so the next /diarize loads it with the new token.
    # The model is not loaded here.
    service._pipeline = None
    service._release_gpu_cache()
    log.info("Hugging Face token updated; pyannote reloads on next diarization")
    return JSONResponse({"status": "ok"})


@app.post("/diarize")
async def diarize_endpoint(
    audio: UploadFile = File(...), known_speakers: Optional[str] = Form(None)
) -> JSONResponse:
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty audio body")

    parsed_known_speakers = None
    if known_speakers:
        try:
            parsed_known_speakers = json.loads(known_speakers)
        except (json.JSONDecodeError, TypeError):
            log.warning("Ignoring malformed known_speakers payload")

    try:
        result = service.diarize(data, known_speakers=parsed_known_speakers)
    except Exception as e:
        detail = f"{type(e).__name__}: {e}"
        log.error("Diarization failed: %s", detail)
        log.error("Traceback:\n%s", traceback.format_exc())
        raise HTTPException(status_code=500, detail=detail) from e

    return JSONResponse(result)


@app.post("/enroll")
async def enroll_endpoint(name: str, audio: UploadFile = File(...)) -> JSONResponse:
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty audio body")

    try:
        emb = embedding_service.get_embedding(data)
        profiles_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../data/profiles"))
        os.makedirs(profiles_dir, exist_ok=True)
        profile_path = os.path.join(profiles_dir, f"{name}.npy")
        np.save(profile_path, emb)
        log.info("Enrolled profile for %s (size %s)", name, emb.shape)
        return JSONResponse({"status": "ok", "name": name})
    except Exception as e:
        detail = f"{type(e).__name__}: {e}"
        log.error("Enrollment failed: %s", detail)
        raise HTTPException(status_code=500, detail=detail) from e


@app.post("/process-file")
async def process_file_endpoint(audio: UploadFile = File(...)) -> JSONResponse:
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty audio body")

    try:
        suffix = os.path.splitext(audio.filename)[1] if audio.filename else ".wav"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        try:
            log.info("Processing file with local Parakeet MLX...")
            result = parakeet_service.model.transcribe(tmp_path, chunk_duration=120.0)
            mx.clear_cache()

            log.info("Processing file with local Pyannote...")
            diarization_result = service.diarize_file(tmp_path)
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

        aligned_chunks = []
        for i, segment in enumerate(result.sentences):
            best_speaker = "Speaker ?"
            best_overlap = 0.0

            for diar_seg in diarization_result["segments"]:
                overlap = max(0.0, min(segment.end, diar_seg["end"]) - max(segment.start, diar_seg["start"]))
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_speaker = diar_seg["speaker"]

            aligned_chunks.append({
                "id": i + 1,
                "text": segment.text.strip(),
                "isFinal": True,
                "timestamp": int(time.time() * 1000) + int(segment.start * 1000),
                "audioStart": segment.start,
                "audioEnd": segment.end,
                "speaker": best_speaker if best_overlap > 0 else "Speaker ?"
            })

        log.info("Processed file offline: %d chunks, %d speakers", len(aligned_chunks), diarization_result["num_speakers"])
        return JSONResponse({
            "transcriptChunks": aligned_chunks,
            "numSpeakers": diarization_result["num_speakers"],
            "duration": diarization_result["duration"]
        })
    except Exception as e:
        detail = f"{type(e).__name__}: {e}"
        log.error("Process-file failed: %s", detail)
        log.error("Traceback:\n%s", traceback.format_exc())
        raise HTTPException(status_code=500, detail=detail) from e


@app.websocket("/stream-transcribe")
async def stream_transcribe_endpoint(websocket: WebSocket):
    await websocket.accept()
    log.info("[WS] Client connected for local Parakeet MLX streaming")

    try:
        model = parakeet_service.model
    except Exception as e:
        log.error("Failed to load Parakeet MLX model: %s", e)
        await websocket.close(code=1011, reason="Failed to load Parakeet MLX model")
        return

    transcriber = ParakeetStreamingTranscriber(model)

    async def receive_audio():
        try:
            while True:
                data = await websocket.receive_bytes()
                transcriber.add_audio(data)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            log.error("[WS] Receive error: %s", e)

    rx_task = asyncio.create_task(receive_audio())

    try:
        while not rx_task.done():
            await asyncio.sleep(0.5)
            results = transcriber.transcribe()
            for res in results:
                await websocket.send_json({
                    "text": res["text"],
                    "isFinal": res["isFinal"],
                    "audioStart": res["audioStart"],
                    "audioEnd": res["audioEnd"],
                })
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.error("[WS] Processing error: %s", e)
    finally:
        rx_task.cancel()
        transcriber.close()
        log.info("[WS] Client disconnected from local Parakeet MLX streaming")


if __name__ == "__main__":
    import uvicorn

    log.info("Starting local AI sidecar on http://%s:%d", HOST, PORT)
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
