"""Two bounded fixed samples from the approved isolated CPU installation; no network."""
import hashlib
import importlib.util
import json
import sys
import time
from pathlib import Path
runtime = Path(sys.argv[1])
worker = runtime / "worker.py"
assert hashlib.sha256(worker.read_bytes()).hexdigest() == "21b2a73dfe79ac3718bc88b25d93be5d56a17a71695682cc4e4c01eb3f4e6838"
spec = importlib.util.spec_from_file_location("namzu_ema_diagnostic", worker)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
tts, np = module.load_engine(runtime / "models")
text = "Merhaba! Ben Namzu. Türkçe seslendirme bu cihazda çalışıyor."
seed = 20261007
normalized = tts._frontend(text)
assert len(normalized) <= 2000
pieces = tts._pieces(text, 1.0, seed)
assert len(pieces) <= 16
with tts._engine.lock:
    tts._engine.plan(pieces, 1.0)
plan = [{"letters": p.letters, "frames": p.frames, "seconds": p.frames / 25, "pause": p.pause} for p in pieces]
results = {}
for rate in (48000, 24000):
    count = chunks = 0
    started = time.perf_counter()
    peak = 0.0
    first_ms = None
    iterator = iter(tts.stream(text, seed=seed, sample_rate=rate))
    try:
        for samples in iterator:
            assert samples.ndim == 1 and np.isfinite(samples).all()
            chunks += 1
            count += samples.size
            assert chunks <= 128 and count <= rate * 90
            if first_ms is None:
                first_ms = 1000 * (time.perf_counter() - started)
            if samples.size:
                peak = max(peak, float(np.abs(samples).max()))
    finally:
        iterator.close()
    results[str(rate)] = {"samples": int(count), "seconds": count / rate, "chunks": chunks, "firstAudioMs": first_ms, "peak": peak}
ratio_ok = abs(results["24000"]["samples"] * 2 - results["48000"]["samples"]) <= 1
print(json.dumps({"passed": ratio_ok, "normalizedFixedSample": normalized, "originalChars": len(text), "normalizedChars": len(normalized), "plan": plan, "rates": results, "rateCountsAgree": ratio_ok}))
assert ratio_ok
