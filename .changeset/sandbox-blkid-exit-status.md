---
"@namzu/sandbox": patch
---

The Kubernetes-backend guest entrypoint (`packages/sandbox/k8s/entrypoint.sh`) no longer treats every `blkid` failure as "the workspace disk is empty."

Previously `blkid`'s exit status was folded away with `2>/dev/null || true`, so a `blkid` that was missing from `PATH` (127), not executable (126), erroring (4), or answering ambiguously (8) looked identical to a device that genuinely carries no filesystem — and the entrypoint ran `mkfs.ext4 -F` on it either way. On an image whose `PATH` omits `blkid`'s directory, or that ships a broken `blkid`, that reformats an already-populated, resumed workspace disk instead of refusing to touch it.

The entrypoint now keeps `blkid`'s exit status and acts on it: only status 2 ("no filesystem found", `blkid(8)`) may lead to `mkfs`, and only once a raw `dd` read confirms the device can actually be probed (status 2 also covers "blkid could not read the device at all"). Every other outcome — a missing tool, a non-2/non-0 status, or a 0 exit with no printed type — aborts the pod instead, naming the status and leaving `blkid`'s own stderr on the container log rather than discarding it. `blkid`, `dd`, `mkfs.ext4`, `mount`, `chown` and `setpriv` are each checked with `command -v` up front, so a missing tool is named explicitly rather than surfacing as a silent format.

No public API changed — this is guest-image/entrypoint behaviour for the `microvm`/`kubernetes` sandbox backend's deployment artifacts, which are not part of the published npm package (`packages/sandbox/k8s/` is excluded from `files`). A host running a workspace template built from the shipped image should rebuild it to pick up the fix.
