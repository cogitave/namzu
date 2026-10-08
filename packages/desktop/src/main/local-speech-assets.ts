/** Immutable upstream inputs, verified against the pinned model-host / PyPI metadata. */
export const EMA_MODEL_REVISION = '7a6ba1ad216bb2f1da9863f80ac8770a6a807632'
export const EMA_SOURCE_REVISION = '129e39c7d9feb56de9c6830e94a630f04fc8aa03'
export const EMA_WHEEL_URL =
	'https://files.pythonhosted.org/packages/58/55/5732a817d07b60293a7b5b98b43453b93b281a11a0a93892ccbe6a05cb3a/ema_lightning-1.0.1-py3-none-any.whl'
export const EMA_WHEEL_SHA256 = '22b16b997a594b9ffcb0681218dc67f2fb8466af4e4dd3e99b48f20a7523d70e'
export const EMA_MODEL_FILES = [
	{
		name: 'ema.pt',
		bytes: 22_285_878,
		sha256: '95aec03dafbe0e1d69bca774ab597c779464729a14bc99bfcb52480090c7dfe6',
	},
	{
		name: 'decoder.pt',
		bytes: 12_103_269,
		sha256: '9595819b173f411340f63d11332695121a97f8bf1f6d8b6fef0b21cf99c7ad67',
	},
] as const

/**
 * Stdio-only CPU worker. No sockets, model-host constructor or unsafe pickle loader.
 * Persisted as a private, hash-verified file only by the explicit installation action.
 */
export const LOCAL_SPEECH_WORKER_SOURCE = String.raw`import argparse
import base64
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import threading
import time

RATE = 24000
SAMPLES = RATE // 5
MAX_TEXT = 8000
MODEL_FILES = {
    "ema.pt": (22285878, "95aec03dafbe0e1d69bca774ab597c779464729a14bc99bfcb52480090c7dfe6"),
    "decoder.pt": (12103269, "9595819b173f411340f63d11332695121a97f8bf1f6d8b6fef0b21cf99c7ad67"),
}
output_lock = threading.Lock()
condition = threading.Condition()
current = None
engine = None
shutting_down = False
last_cpu = None
last_wall = None

def emit(value):
    with output_lock:
        sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
        sys.stdout.flush()

def resident_bytes():
    try:
        if sys.platform == "win32":
            from ctypes import wintypes
            class Counters(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
            counters = Counters()
            counters.cb = ctypes.sizeof(counters)
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.GetCurrentProcess.restype = wintypes.HANDLE
            psapi = ctypes.WinDLL("psapi", use_last_error=True)
            psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
            if psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
                return int(counters.WorkingSetSize)
        elif sys.platform.startswith("linux"):
            pages = int(Path("/proc/self/statm").read_text().split()[1])
            return pages * os.sysconf("SC_PAGE_SIZE")
        # A peak RSS sample is not current resident memory. Other platforms remain unknown.
    except Exception:
        pass
    return None

def resource_sample():
    global last_cpu, last_wall
    wall = time.monotonic()
    cpu = time.process_time()
    percent = None
    if last_wall is not None and wall > last_wall:
        percent = max(0.0, 100.0 * (cpu - last_cpu) / (wall - last_wall))
    last_cpu, last_wall = cpu, wall
    return {"ramBytes": resident_bytes(), "cpuPercent": percent}

def verify_models(directory):
    for name, (size, expected) in MODEL_FILES.items():
        path = directory / name
        if path.is_symlink() or path.stat().st_size != size:
            raise RuntimeError("model integrity")
        digest = hashlib.sha256()
        with path.open("rb") as file:
            while data := file.read(1024 * 1024):
                digest.update(data)
        if digest.hexdigest() != expected:
            raise RuntimeError("model integrity")

def load_engine(directory):
    # EMA() resolves mutable Hub defaults and upstream loaders allow arbitrary pickle.
    # Import architecture code from the pinned wheel and use restricted tensor loading instead.
    import numpy as np
    import torch
    from ema_lightning.api import EMA
    from ema_lightning.model import Acoustic
    from ema_lightning.decoder import Decoder
    from ema_lightning.frontend import Frontend
    torch.set_num_threads(max(1, min(2, os.cpu_count() or 1)))
    torch.set_num_interop_threads(1)
    verify_models(directory)
    acoustic = torch.load(directory / "ema.pt", map_location="cpu", weights_only=True)
    decoder = torch.load(directory / "decoder.pt", map_location="cpu", weights_only=True)
    state = acoustic["ema"]
    shared = bool(acoustic["cfg"].get("shared_ada", any(k.startswith("ada_shared") for k in state)))
    model = Acoustic(acoustic["cfg"], acoustic["vocab"], shared)
    model.load_state_dict(state)
    model.float().eval().requires_grad_(False)
    cfg, state = decoder.get("cfg", {}), decoder["G"]
    for key in [k for k in state if k.endswith("weight_g")]:
        g, v = state.pop(key), state.pop(key[:-1] + "v")
        state[key[:-2]] = g * v / v.norm(dim=tuple(range(1, v.dim())), keepdim=True)
    keys = ("latent_dim", "ch", "rates", "kernels", "rb_kernels", "rb_dilations")
    vocoder = Decoder(**{k: cfg[k] for k in keys if k in cfg})
    vocoder.load_state_dict(state)
    vocoder.float().eval().requires_grad_(False)
    tts = EMA._from_parts(model, vocoder, Frontend(model.vocab), "cpu")
    tts._batch_size = 1  # No surprise batch-size probe or CUDA compilation on a user's first sentence.
    return tts, np

def pieces(text):
    # Do not enqueue an entire long reply in upstream's unbounded sentence scheduler.
    while text:
        end = min(500, len(text))
        if end < len(text):
            boundaries = [m.end() for m in re.finditer(r"[.!?;\n]\s*", text[:end])]
            boundary = boundaries[-1] if boundaries else text.rfind(" ", 0, end)
            if boundary > 0:
                end = boundary
        yield text[:end]
        text = text[end:]

def speech(request, directory):
    global engine, current
    try:
        if engine is None:
            emit({"type": "loading"})
            engine = load_engine(directory)
            emit({"type": "ready", "resources": resource_sample()})
        if request["cancelled"]:
            return
        tts, np = engine
        sequence = 0
        first = True
        for piece in pieces(request["text"]):
            iterator = iter(tts.stream(piece, sample_rate=RATE))
            try:
                for samples in iterator:
                    for offset in range(0, len(samples), SAMPLES):
                        with condition:
                            while len(request["pending"]) >= 2 and not request["cancelled"]:
                                condition.wait()
                            if request["cancelled"]:
                                return
                            request["pending"].add(sequence)
                        pcm = (np.clip(samples[offset:offset + SAMPLES], -1, 1) * 32767).round().astype("<i2")
                        event = {"type": "audio", "requestId": request["id"], "sequence": sequence,
                            "sampleRate": RATE, "pcmBase64": base64.b64encode(pcm.tobytes()).decode("ascii")}
                        if first:
                            event["firstAudioMs"] = 1000 * (time.monotonic() - request["started"])
                            first = False
                        emit(event)
                        sequence += 1
                    if request["cancelled"]:
                        return
            finally:
                iterator.close()
        with condition:
            while request["pending"] and not request["cancelled"]:
                condition.wait()
            if current is request:
                current = None
        if not request["cancelled"]:
            emit({"type": "end", "requestId": request["id"], "resources": resource_sample()})
    except Exception:
        if not request["cancelled"]:
            with condition:
                if current is request:
                    current = None
            # Do not send spoken text, filesystem paths or model pickle diagnostics over IPC.
            emit({"type": "error", "requestId": request["id"], "message": "Local speech generation failed."})
    finally:
        with condition:
            if current is request:
                current = None
            condition.notify_all()

def main():
    global current, shutting_down
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", required=True)
    options = parser.parse_args()
    directory = Path(options.models)
    emit({"type": "started", "resources": resource_sample()})
    for line in sys.stdin:
        if len(line) > 20000:
            break
        try:
            value = json.loads(line)
            if not isinstance(value, dict):
                break
            kind = value.get("type")
            if kind == "speak":
                identity, text = value.get("requestId"), value.get("text")
                if not isinstance(identity, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identity):
                    break
                if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
                    break
                with condition:
                    if current is not None:
                        break
                    current = {"id": identity, "text": text, "cancelled": False, "pending": set(),
                        "started": time.monotonic()}
                    threading.Thread(target=speech, args=(current, directory), daemon=True).start()
            elif kind == "ack":
                with condition:
                    if current and value.get("requestId") == current["id"]:
                        current["pending"].discard(value.get("sequence"))
                        condition.notify_all()
            elif kind in ("cancel", "shutdown"):
                with condition:
                    if current and (kind == "shutdown" or value.get("requestId") == current["id"]):
                        current["cancelled"] = True
                        condition.notify_all()
                if kind == "shutdown":
                    shutting_down = True
                    break
            elif kind == "sample":
                emit({"type": "resources", "resources": resource_sample()})
            else:
                break
        except (ValueError, TypeError):
            break

if __name__ == "__main__":
    main()
`
