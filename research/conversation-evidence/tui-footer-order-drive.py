#!/usr/bin/env python3
"""Drive the real namzu TUI under a pseudo-terminal.

Spawns `node --import <preload> <cli-bin>` inside a PTY sized 100x30, feeds it
keystrokes the way an operator would (char-by-char, with the delays
`cli-pty-dogfood-harness` found necessary — a burst reads as a paste chip and
swallows the Enter that follows too closely), and records the raw byte stream
to disk so a separate renderer can reconstruct the screen at any point in
time. Recorded checkpoints are BYTE OFFSETS into that capture, not screen
snapshots — replaying from byte 0 up to a checkpoint in a fresh terminal
emulator is what makes the reconstruction trustworthy (ANSI cursor state is
sequential).

Invoked with a single JSON argument (a file path) describing the run; writes
a JSON result next to it. See `tui-footer-order-cli.mjs` for the schema.
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
COMPOSER_TIMEOUT = 90.0
AGENTS_TIMEOUT = 60.0
POST_SETTLE = 0.6


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
    prompt_text = cfg["promptText"]

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
        # Child: replace this process with node.
        try:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        except Exception as exc:  # pragma: no cover - exec failure path
            os.write(2, f"exec failed: {exc}\n".encode())
            os._exit(127)

    # Parent: size the pty, then pump output.
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

    try:
        # Drain boot output until the composer placeholder shows, or a trust
        # prompt shows up despite the pre-seeded trust store (defensive: some
        # other path could still land there).
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

        # Per cli-pty-dogfood-harness: the computer-use capability probe adds
        # a notice on WSL a few seconds after the composer is already usable.
        # Settle before doing anything else so it cannot land mid-keystroke.
        read_available(20.0)
        checkpoint("settled")

        # Shift+Tab: prompt -> accept-edits.
        send_raw(b"\x1b[Z")
        read_available(0.5)
        checkpoint("idle_mode_on")

        send_text(prompt_text)
        # Wait for the app to actually have DRAINED and rendered the typed
        # text before sending Enter as a fully separate write. Node's stdin
        # stream buffers whatever arrived since the last `.read()`; if the
        # app is still busy re-rendering an earlier keystroke when `\r`
        # arrives, both land in the same drained chunk and Ink's parser reads
        # the whole thing as literal pasted text (trailing `\r` included)
        # instead of dispatching a `key.return` press. Seeing the typed tail
        # on screen is proof the previous keystroke was fully processed.
        tail = prompt_text[-12:]
        pump_until(lambda t: tail in t, 20.0, "typed_text_rendered")
        time.sleep(SETTLE_DELAY)
        send_raw(b"\r")

        # Belt-and-braces: if the composer still shows the typed text a few
        # seconds later, the Enter landed in the same drained chunk as an
        # earlier keystroke (see above) and was inserted as literal content
        # rather than dispatched as `key.return`. Retrying costs nothing when
        # submission already worked — the composer is empty by then, so a
        # stray `\r` finds nothing to submit.
        agents_found = False
        for attempt in range(4):
            agents_found = pump_until(
                lambda t: "Release audit" in t or "agents ·" in t or "agent ·" in t,
                AGENTS_TIMEOUT / 4,
                f"agents_visible_attempt_{attempt}",
            )
            if agents_found:
                break
            still_in_composer = tail in captured.decode("utf-8", errors="ignore")
            if not still_in_composer:
                # Submitted, just still working — keep waiting on the next loop.
                continue
            log(f"attempt {attempt}: Enter did not submit — retrying")
            send_raw(b"\r")
            time.sleep(0.5)
        read_available(POST_SETTLE)
        checkpoint("two_live_agents")
        if not agents_found:
            result["errors"].append("agent rail never appeared within timeout")

        # Ctrl+T opens the agent cockpit.
        send_raw(b"\x14")
        read_available(1.0)
        checkpoint("cockpit")

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
