#!/usr/bin/env python3
"""Drive the Namzu CLI TUI in a real PTY, per a JSON step spec.

The child is a real process on a real controlling terminal; every byte it writes
is appended to a raw capture file as it arrives, and every keystroke we send is
logged with a timestamp. Nothing here is specific to the prompt content.

Usage:
  pty_drive.py --spec spec.json --raw-out capture.bin --log events.jsonl \
               --cwd <dir> --entry <path/to/bin.js> [-- node args...]

Spec: a JSON object {"steps": [...]} where each step is one of
  {"wait_for": "text", "timeout": 90}     wait until capture contains text
  {"wait": 20}                            sleep N seconds
  {"type": "hello", "submit": true}       type char-by-char, then optionally \r
  {"key": "ctrl-c"}                        send a control byte
  {"quit": true}                          terminate the child
"""

import argparse
import ctypes
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import threading
import time

CHAR_DELAY = 0.02
SETTLE_BEFORE_CR = 1.0
# TIOCGPTN: "which pts is this master's slave?" — _IOR('T', 0x30, unsigned int)
TIOCGPTN = 0x80045430


class Harness:
    def __init__(self, args):
        self.args = args
        self.buf = bytearray()
        self.lock = threading.Lock()
        self.events = []
        # One record per read chunk: {"t": seconds, "off": byte offset it landed
        # at, "len": bytes read}. This is what turns "the needle was in the file"
        # into "the needle arrived at t=92s", which a bare timeout cannot say.
        self.chunks = []
        self.start = time.monotonic()
        self.alive = True
        self.log_file = None

    def now(self):
        return round(time.monotonic() - self.start, 3)

    def log(self, kind, **kw):
        rec = {"t": self.now(), "kind": kind}
        rec.update(kw)
        self.events.append(rec)
        # Written through, not buffered to the end: a run that hangs must still
        # be readable while it hangs, which is when the log is worth most.
        if self.log_file is not None:
            self.log_file.write(json.dumps(rec) + "\n")
            self.log_file.flush()

    def text(self):
        with self.lock:
            return bytes(self.buf).decode("utf-8", "replace")

    def reader(self, fd, raw_path):
        with open(raw_path, "wb") as raw:
            while self.alive:
                try:
                    r, _, _ = select.select([fd], [], [], 0.2)
                except (OSError, ValueError):
                    break
                if not r:
                    continue
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                raw.write(chunk)
                raw.flush()
                with self.lock:
                    self.chunks.append(
                        {"t": self.now(), "off": len(self.buf), "len": len(chunk)}
                    )
                    self.buf.extend(chunk)

    def wait_for(self, needle, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if needle in self.text():
                self.log("wait_for_ok", needle=needle)
                return True
            time.sleep(0.1)
        self.log("wait_for_timeout", needle=needle, timeout=timeout)
        return False

    def type_text(self, fd, s, submit):
        for i, ch in enumerate(s):
            os.write(fd, ch.encode("utf-8"))
            time.sleep(CHAR_DELAY)
        self.log("typed", chars=len(s), submit=submit)
        if submit:
            time.sleep(SETTLE_BEFORE_CR)
            os.write(fd, b"\r")
            self.log("sent_cr")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--raw-out", required=True)
    ap.add_argument("--log", required=True)
    ap.add_argument("--cwd", required=True)
    ap.add_argument("--entry", required=True)
    ap.add_argument("--node", default="node")
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("--rows", type=int, default=42)
    ap.add_argument("--arg", action="append", default=[])
    ap.add_argument("--env", action="append", default=[])
    ap.add_argument("--drain-after-quit", type=float, default=6.0)
    args = ap.parse_args()

    spec = json.load(open(args.spec))
    os.makedirs(os.path.dirname(os.path.abspath(args.raw_out)), exist_ok=True)

    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    env["COLUMNS"] = str(args.cols)
    env["LINES"] = str(args.rows)
    # Do NOT export CI. Ink resolves interactivity as
    # `interactive ?? (!isInCi && stdout.isTTY)`; the CLI passes no explicit
    # value, so `CI=1` here makes Ink non-interactive on a perfectly good TTY.
    # A non-interactive Ink defers the whole dynamic frame and writes it only
    # when it unmounts, and ignores stdin — so the composer never appears, the
    # keys go nowhere, and the only frame you ever capture is the teardown one.
    # A PTY harness that wants to see an interactive TUI must not claim CI.
    env.pop("CI", None)
    for kv in args.env:
        k, _, v = kv.partition("=")
        env[k] = v

    h = Harness(args)
    h.log_file = open(args.log, "w")

    master, slave = pty.openpty()
    fcntl.ioctl(
        master, termios.TIOCSWINSZ, struct.pack("HHHH", args.rows, args.cols, 0, 0)
    )

    def preexec():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    argv = [args.node, args.entry] + list(args.arg)
    h.log("spawn", argv=" ".join(argv), cwd=args.cwd, cols=args.cols, rows=args.rows)
    proc = subprocess.Popen(
        argv,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        cwd=args.cwd,
        env=env,
        preexec_fn=preexec,
        close_fds=True,
    )
    os.close(slave)
    h.log("pid", pid=proc.pid)

    # Prove, from inside the harness, that the child is on the pty we read.
    # Reading /proc/<pid>/fd from another process is not a substitute: a
    # sandbox can give the reader its own devpts, so the same tty shows up at a
    # different index, or a different tty shows up at fd 3. Both numbers below
    # come from this process, so a mismatch is real.
    slave_minor = None
    try:
        buf = ctypes.create_string_buffer(4)
        fcntl.ioctl(master, TIOCGPTN, buf, True)
        slave_minor = struct.unpack("I", buf.raw)[0]
    except Exception as exc:  # noqa: BLE001
        h.log("pty_check_error", error=repr(exc))
    child_tty_nr = None
    try:
        with open(f"/proc/{proc.pid}/stat") as fh:
            raw_stat = fh.read()
        child_tty_nr = int(raw_stat[raw_stat.rindex(")") + 2 :].split()[4])
    except Exception as exc:  # noqa: BLE001
        h.log("pty_check_error", error=repr(exc))
    h.log(
        "pty_check",
        harness_slave_minor=slave_minor,
        child_tty_nr=child_tty_nr,
        same_pty=bool(
            slave_minor is not None
            and child_tty_nr is not None
            and os.minor(child_tty_nr) == slave_minor
        ),
    )

    t = threading.Thread(target=h.reader, args=(master, args.raw_out), daemon=True)
    t.start()

    try:
        for step in spec["steps"]:
            if "wait_for" in step:
                h.wait_for(step["wait_for"], step.get("timeout", 90))
            elif "wait" in step:
                time.sleep(step["wait"])
            elif "type" in step:
                h.type_text(master, step["type"], step.get("submit", False))
            elif "key" in step:
                keys = {
                    "ctrl-c": b"\x03",
                    "ctrl-d": b"\x04",
                    "esc": b"\x1b",
                    "enter": b"\r",
                    "tab": b"\t",
                    "alt-w": b"\x1bw",
                    "backspace": b"\x7f",
                    "up": b"\x1b[A",
                    "down": b"\x1b[B",
                    "right": b"\x1b[C",
                    "left": b"\x1b[D",
                    "ctrl-u": b"\x15",
                }
                os.write(master, keys[step["key"]])
                h.log("key", key=step["key"])
            elif "paste" in step:
                # A bracketed paste: one event however the bytes arrive.
                os.write(master, b"\x1b[200~" + step["paste"].encode("utf-8") + b"\x1b[201~")
                h.log("paste", chars=len(step["paste"]))
            elif "burst" in step:
                # The whole text in one write: a paste without markers.
                os.write(master, step["burst"].encode("utf-8"))
                h.log("burst", chars=len(step["burst"]))
            elif "mark" in step:
                # A named point in the capture, to render the screen as it stood.
                with h.lock:
                    h.log("mark", name=step["mark"], offset=len(h.buf))
            elif "quit" in step:
                break
    except Exception as exc:  # noqa: BLE001
        h.log("harness_error", error=repr(exc))

    # Let the child finish a clean exit on its own before we touch it.
    deadline = time.monotonic() + args.drain_after_quit
    while time.monotonic() < deadline and proc.poll() is None:
        time.sleep(0.2)

    rc = proc.poll()
    if rc is None:
        h.log("still_running_after_drain", seconds=args.drain_after_quit)
        h.alive = False
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        rc = proc.poll()
        h.log("exit", code=rc, forced=True)
    else:
        h.alive = False
        h.log("exit", code=rc, forced=False)

    time.sleep(0.6)
    # The event log was written through as it happened; only the chunk index
    # is left to flush.
    if h.log_file is not None:
        h.log_file.close()
    with open(args.log + ".chunks.jsonl", "w") as fh:
        for rec in h.chunks:
            fh.write(json.dumps(rec) + "\n")
    print(json.dumps({"exit_code": rc, "raw_bytes": len(h.buf)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
