#!/usr/bin/env python3
"""Drive the namzu TUI in a real pty: start a turn against a provider that
never answers, stop the TUI with a signal (SIGTERM, or SIGHUP by closing the
terminal), then report whether the conversation can be taken at once.

Usage: tui-signal-release-drive.py <SIGTERM|SIGHUP|SIGINT> <cli dist/bin.js> <sdk dist/index.js> <outdir>

SIGHUP is sent the way a terminal sends it: by closing the pty master.
Results for 2026-09-22 are in tui-signal-release-results.md.
"""
import http.server
import json
import os
import pty
import select
import signal
import subprocess
import sys
import tempfile
import termios
import threading
import time

mode, BIN, SDK, OUT = sys.argv[1:5]
os.makedirs(OUT, exist_ok=True)
root = tempfile.mkdtemp(prefix=f"tui-{mode}-", dir=OUT)
home = os.path.join(root, "home")
nhome = os.path.join(home, ".namzu")
work = os.path.join(root, "work")
os.makedirs(nhome)
os.makedirs(work)
with open(os.path.join(work, "namzu.config.json"), "w") as f:
    json.dump({"sandbox": {"enabled": False}}, f)
with open(os.path.join(nhome, "trust.json"), "w") as f:
    json.dump({"version": 1, "trusted": [os.path.realpath(work)]}, f)
with open(os.path.join(nhome, "preferences.json"), "w") as f:
    json.dump({"version": 3, "providers": [{"id": "openai", "model": "gpt-4o"}]}, f)

posts = []


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps({"object": "list", "data": [{"id": "gpt-4o", "object": "model", "created": 0, "owned_by": "t"}]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        posts.append(self.path)
        time.sleep(3600)  # never answer


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]

env = {k: v for k, v in os.environ.items() if k not in ("CI",)}
env.update({
    "HOME": home,
    "NAMZU_HOME": nhome,
    "OPENAI_API_KEY": "sk-test",
    "OPENAI_BASE_URL": f"http://127.0.0.1:{port}/v1",
    "TERM": "xterm-256color",
    "COLUMNS": "120",
    "LINES": "40",
})
env["PATH"] = ":".join(p for p in env.get("PATH", "").split(":") if not p.startswith("/mnt"))

pid, fd = pty.fork()
if pid == 0:
    os.chdir(work)
    os.execvpe("node", ["node", BIN], env)

buf = bytearray()
start = time.monotonic()


def pump(t):
    end = time.monotonic() + t
    while time.monotonic() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return False
            if not chunk:
                return False
            buf.extend(chunk)
    return True


def wait_for(needle, timeout):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if needle.encode() in bytes(buf):
            return True
        if not pump(0.2):
            return False
    return False


ok = wait_for("Type a message", 120)
print("composer:", ok, round(time.monotonic() - start, 1))
pump(20)  # WSL computer-use probe notice lands late; let boot settle
for ch in "hi":
    os.write(fd, ch.encode())
    pump(0.05)
pump(1.0)
os.write(fd, b"\r")
end = time.monotonic() + 60
while not posts and time.monotonic() < end:
    pump(0.2)
print("completion request:", bool(posts), round(time.monotonic() - start, 1))
pump(1.0)

check = r"""
const { DiskSessionLog, asSessionId } = await import(process.argv[1])
const { readdirSync } = await import('node:fs')
const { join } = await import('node:path')
const projects = join(process.argv[2], 'projects')
const out = []
for (const slug of readdirSync(projects)) {
  for (const f of readdirSync(join(projects, slug))) {
    if (!f.endsWith('.jsonl')) continue
    const id = f.slice(0, -6)
    const log = new DiskSessionLog({ sessionId: asSessionId(id), file: join(projects, slug, f), sessionDir: join(projects, slug, id) })
    const active = await log.activeTurn()
    const lease = process.argv[3] === 'claim' ? await log.claim({ holder: 'checker', ttlMs: 60000 }) : undefined
    const types = (await log.readAll()).entries.map((e) => e.record.type)
    out.push({ id, active: active && active.state, claimed: lease === undefined ? 'not tried' : lease !== null, tail: types.slice(-3) })
    if (lease) await log.release(lease)
  }
}
console.log(JSON.stringify(out))
"""


def sdk_check(claim):
    return subprocess.run(["node", "--input-type=module", "-e", check, SDK, nhome, "claim" if claim else "peek"],
                          capture_output=True, text=True, env=env).stdout.strip() or "(no output)"


print("before signal:", sdk_check(False))
t0 = time.monotonic()
if mode == "SIGHUP":
    os.close(fd)  # the terminal closes: the kernel hangs the session up
    fd = -1
else:
    os.kill(pid, getattr(signal, mode))
status = None
while time.monotonic() - t0 < 30:
    if fd >= 0:
        pump(0.1)
    wpid, st = os.waitpid(pid, os.WNOHANG)
    if wpid:
        status = st
        break
    time.sleep(0.05)
elapsed = round(time.monotonic() - t0, 2)
if status is None:
    print("child still alive after 30s; killing")
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
else:
    how = f"signal {signal.Signals(os.WTERMSIG(status)).name}" if os.WIFSIGNALED(status) else f"exit {os.WEXITSTATUS(status)}"
    print("child ended:", how, "after", elapsed, "s")
print("after exit:", sdk_check(True))
if fd >= 0:
    pump(0.5)
    attrs = termios.tcgetattr(fd)
    lflag = attrs[3]
    print("terminal after exit: ICANON", bool(lflag & termios.ICANON), "ECHO", bool(lflag & termios.ECHO))
    tail = bytes(buf[-400:])
    print("cursor shown at the end:", b"\x1b[?25h" in tail)
    print("resume hint printed:", b"To resume this conversation" in bytes(buf))
with open(os.path.join(root, "capture.bin"), "wb") as f:
    f.write(bytes(buf))
print("capture:", os.path.join(root, "capture.bin"))
