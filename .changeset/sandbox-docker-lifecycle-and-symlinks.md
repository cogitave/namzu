---
'@namzu/sandbox': patch
---

fix(sandbox): docker backend lifecycle leak + worker symlink escape

Two issues Codex stop-time review caught on the just-shipped
`container:docker` backend (#32):

**HIGH — container lifecycle leak.** `spawnDockerSandbox`'s create
path had no rollback on failure. If `docker run` succeeded but
`/healthz` polling timed out (slow image, kernel under pressure,
network-namespace setup hiccup), the temp workspace under `/tmp/`
plus the running container were both orphaned. The
`reservePort()` pattern also had a TOCTOU race: this process
allocated a host port, closed the listening socket, then passed
the number to `docker run --publish 127.0.0.1:PORT:…`, leaving a
window where another process could bind the same port.

Fixed:
- `spawnDockerSandbox` now wraps create in `try/catch`. The catch
  arm runs `cleanupOnFailure()` which `docker rm -f`s the
  container if it started and removes `hostWorkspace` if it was
  created. Both are tracked via a flag/var captured in the outer
  scope.
- Switched from pre-reserve-then-publish to letting Docker
  allocate via `--publish 127.0.0.1::WORKER_PORT`. The mapped
  host port is read back via `docker inspect --format
  '{{(index ...).HostPort}}'`. No TOCTOU window.

**MEDIUM — symlink escape in worker.** `resolveWithinWorkspace()`
in the worker's `/read-file` and `/write-file` handlers checked
the lexical path string but `fs.readFile` / `fs.writeFile`
follow symlinks. A symlink inside `/workspace` pointing to
`/etc/passwd` (or anywhere outside the bind-mount) bypassed the
boundary.

Fixed: added `realpathWithinWorkspace()` which `realpath`s both
the workspace root and the requested target, then verifies the
resolved real path is still inside the workspace. For writes
where the target may not exist yet, the parent directory's
realpath is checked instead. Both handlers now resolve through
the new helper before touching the file.
