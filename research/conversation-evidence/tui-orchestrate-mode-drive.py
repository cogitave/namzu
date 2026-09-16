#!/usr/bin/env python3
"""Drive the real namzu TUI under a pseudo-terminal, running a SCRIPTED
sequence of steps instead of the one hardcoded scenario in
`tui-footer-order-drive.py`.

Adapted from `tui-footer-order-drive.py` (not edited — that file is reused
unchanged by other harnesses in this directory, e.g. `narration-band-cli.mjs`,
whose single fixed prompt-then-wait-for-agents scenario cannot open the effort
picker, navigate it, or drive a `/model` switch). The PTY plumbing (fork,
window size, byte capture, checkpoint-as-byte-offset) is identical; what
changed is that the interaction itself comes from the caller as a JSON list of
steps, so ONE driver can run every scenario this verification needs:

  - open the effort picker and read it before touching anything;
  - press a bare digit to select a specific row (namzu's picker applies a
    numbered row immediately — see `App.tsx`'s `/^[1-9]$/` handling — so this
    needs no arrow-key counting that would drift if the picker's option list
    ever grows);
  - drive `/model <name>` the same way an operator would;
  - submit a prompt and let the scripted provider run several turns.

Invoked with a single JSON argument (a file path) describing the run; writes
a JSON result next to it. See `tui-orchestrate-mode-cli.mjs` for the step
schema.
"""

import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

STEP_DELAY = 0.02  # seconds between characters of a typed message
SETTLE_DELAY = 1.0  # seconds between the last character and Enter
DEFAULT_TIMEOUT = 60.0
COMPOSER_TIMEOUT = 90.0

KEYS = {
    "enter": b"\r",
    "escape": b"\x1b",
    "up": b"\x1b[A",
    "down": b"\x1b[B",
    "left": b"\x1b[D",
    "right": b"\x1b[C",
    "shift_tab": b"\x1b[Z",
    "ctrl_t": b"\x14",
    "ctrl_c": b"\x03",
    "backspace": b"\x7f",
}


def log(msg):
    sys.stderr.write(f"[drive] {msg}\n")
    sys.stderr.flush()


def main():
    with open(sys.argv[1], encoding="utf-8") as f:
        cfg = json.load(f)

    argv = cfg["argv"]
    cwd = cfg["cwd"]
    env = cfg["env"]
    cols = cfg.get("cols", 100)
    rows = cfg.get("rows", 30)
    capture_path = cfg["capturePath"]
    steps = cfg.get("steps", [])

    result = {
        "checkpoints": {},
        "markersSeen": {},
        "errors": [],
        "capturePath": capture_path,
    }

    cap = open(capture_path, "wb")
    captured = bytearray()

    pid, master_fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        except Exception as exc:  # pragma: no cover - exec failure path
            os.write(2, f"exec failed: {exc}\n".encode())
            os._exit(127)

    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)

    def read_available(timeout):
        end = time.monotonic() + timeout
        got_any = False
        while True:
            remaining = end - time.monotonic()
            if remaining <= 0:
                break
            ready, _, _ = select.select([master_fd], [], [], min(remaining, 0.2))
            if not ready:
                continue
            try:
                chunk = os.read(master_fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            captured.extend(chunk)
            cap.write(chunk)
            cap.flush()
            got_any = True
        return got_any

    def pump_until(predicate, timeout, label):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            read_available(0.3)
            text = captured.decode("utf-8", errors="ignore")
            if predicate(text):
                result["markersSeen"][label] = True
                return True
        result["markersSeen"][label] = False
        return False

    def checkpoint(name):
        cap.flush()
        result["checkpoints"][name] = len(captured)
        log(f"checkpoint {name} @ byte {len(captured)}")

    def send_raw(data: bytes):
        os.write(master_fd, data)

    def send_text(text: str):
        for ch in text:
            os.write(master_fd, ch.encode())
            time.sleep(STEP_DELAY)

    def type_and_submit(text, expect_pattern, expect_timeout, label):
        """The typed-message dance `tui-footer-order-drive.py` found necessary:
        wait for the typed tail to actually render before sending a SEPARATE
        Enter keystroke, and retry the Enter if the composer still shows the
        text a few seconds later (both symptoms of Ink reading a burst as one
        pasted chunk, `\\r` included, instead of dispatching `key.return`)."""
        send_text(text)
        tail = text[-12:] if len(text) >= 12 else text
        pump_until(lambda t: tail in t, 20.0, f"{label}_typed")
        time.sleep(SETTLE_DELAY)
        send_raw(b"\r")
        found = False
        for attempt in range(4):
            found = pump_until(
                expect_pattern, expect_timeout / 4, f"{label}_attempt_{attempt}"
            )
            if found:
                break
            still_in_composer = tail in captured.decode("utf-8", errors="ignore")
            if not still_in_composer:
                continue
            log(f"{label}: Enter did not submit — retrying")
            send_raw(b"\r")
            time.sleep(0.5)
        if not found:
            result["errors"].append(f"{label}: expected text never appeared")
        return found

    try:
        found = pump_until(
            lambda t: "Type a message" in t or "trust this folder" in t,
            COMPOSER_TIMEOUT,
            "composer_or_trust",
        )
        if not found:
            result["errors"].append("composer never appeared within timeout")
            checkpoint("timeout_no_composer")
            raise SystemExit(0)

        if "trust this folder" in captured.decode("utf-8", errors="ignore"):
            log("unexpected trust prompt — accepting")
            send_raw(b"y")
            pump_until(lambda t: "Type a message" in t, COMPOSER_TIMEOUT, "composer_after_trust")

        checkpoint("composer_ready")

        # Per cli-pty-dogfood-harness: settle before doing anything else so a
        # delayed boot notice (e.g. a capability probe) cannot land mid-step.
        read_available(20.0)
        checkpoint("settled")

        for step in steps:
            op = step["op"]
            if op == "checkpoint":
                read_available(step.get("settle", 0.3))
                checkpoint(step["name"])
            elif op == "key":
                name = step["name"]
                data = KEYS.get(name)
                if data is None:
                    data = name.encode()
                send_raw(data)
                read_available(step.get("settle", 0.4))
            elif op == "type_submit":
                type_and_submit(
                    step["text"],
                    lambda t, pat=step["expect"]: pat in t,
                    step.get("timeout", DEFAULT_TIMEOUT),
                    step["label"],
                )
            elif op == "wait":
                pump_until(
                    lambda t, pat=step["pattern"]: pat in t,
                    step.get("timeout", DEFAULT_TIMEOUT),
                    step["label"],
                )
            elif op == "sleep":
                read_available(step["seconds"])
            else:
                result["errors"].append(f"unknown step op: {op}")

    finally:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        time.sleep(0.3)
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        cap.close()
        result["totalBytes"] = len(captured)
        out_path = sys.argv[1] + ".result.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)
        log(f"wrote result to {out_path}")


if __name__ == "__main__":
    main()
