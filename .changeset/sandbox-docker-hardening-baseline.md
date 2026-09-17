---
'@namzu/sandbox': major
---

`container:docker` completes its hardening baseline, and a container's root
filesystem is now read-only.

**Before:** the backend passed `--cap-drop=ALL` and
`--security-opt=no-new-privileges` and nothing else of its own, so every path
inside the container was writable, the container's IPC namespace was whatever
the host daemon's `default-ipc-mode` said about sharing it, and CPU was the one
resource of the three that had no way to be bounded at all.

**After:** `--ipc private` and `--read-only` are applied to every container, the
four paths that have to stay writable are mounted `--tmpfs` (`/tmp`, `/var/tmp`,
`/workspace`, `/home/namzu`, each named with its reason in
`src/backends/docker/index.ts`), and a new `cpuLimit` renders `--cpus`.

**What breaks.** A workload that writes inside the container outside those four
paths and the layout's own RW binds — `/opt`, `/srv`, `/etc`, or the `HOME` of an
image whose user is not `namzu` — now fails with `EROFS` instead of succeeding.

A second and much narrower break, in the same class: `--ipc private` makes this
container's IPC namespace un-joinable. Docker's `--ipc container:<name>` is gated
on the target having a shared-memory directory to enter, and a container created
`private` has none — so a container that reached into a sandbox's shared memory,
semaphores or message queues that way, which it could because these sandboxes
were created `shareable` on any host whose daemon was configured with
`default-ipc-mode: shareable`, is now refused by the daemon.

Scratch also lives in RAM now rather than on the container's writable layer. A
temp file larger than half the host's RAM, or larger than `--memory` when the
host set one, fails with `ENOSPC` or is OOM-killed, where writing it to disk used
to succeed. Any workload that spills more than its memory budget into `/tmp`,
`/var/tmp` or `/workspace` is in that group.
Everything the reference image does keeps working: `/tmp` stays executable
(docker's own `--tmpfs` default is `noexec`, which would have turned
`gcc -o /tmp/a.out … && /tmp/a.out` into `Permission denied`), and `HOME` stays
writable, which is what LibreOffice, matplotlib and npm need.

**What to do.** For an image of your own, name what it needs writable in
`writableRootfsPaths`; each entry becomes a `--tmpfs`, so it is scratch rather
than persistence. For a workload that spills more scratch than its memory
budget, move the spill rather than the baseline: `layout.scratch` is a bind to a
host directory and is still disk-backed, so give the layout one on a host
directory with room and point the workload at it with the per-call `env` option
— `TMPDIR` set to that container path — which keeps the read-only root
filesystem, the four paths above and the resource bounds. To give the
filesystem back — every path inside the container writable again — set
`readOnlyRootfs: false`. That turns off that one control: `--ipc private` is
applied whatever it says, so what it produces is the argv from before plus that
one flag, not the argv from before.

`cpuLimit` is opt-in and has no default, deliberately: a number chosen here
would throttle a run that finishes inside its timeout today, and the right value
is a property of the host's machine. It is new surface, and no workload that
works today can fail because of it.

SemVer: **major**, because two defaults changed in ways a working workload can
fail under. The additive parts (`cpuLimit`, `writableRootfsPaths`,
`readOnlyRootfs`) would be a `minor` on their own.
