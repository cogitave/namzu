---
'@namzu/sdk': minor
---

Add a Linux sandbox tier that actually confines the filesystem.

Until now the strongest tier a Linux host could get was `linux-namespace`, and `isolation.ts` has always said what that is worth: `{ filesystem: false, network: true, process: true }`. It unshares a mount namespace and never remounts, so the child still sees — and can write to — the whole host filesystem. `read`, `edit` and the code-navigation tools are path-contained by a shared helper, but a model-issued shell command is not, and no OS boundary stood behind it.

`linux-bwrap` is the tier that remounts. It builds a fresh mount table holding the sandbox root read-write, the system paths a binary needs read-only, a private `/proc`, `/dev` and `/tmp`, and nothing else. A host path is not unreadable, it is **absent** — `ENOENT`, not `EACCES` — which is the difference between a boundary and a permission bit. `--unshare-all` supplies the network and process controls in the same call, so all three rows of the tier's isolation report come from one spawn.

Detection prefers it and probes it the way the existing tier is probed: by running the real confinement, not by asking the binary its version. A host with `bwrap` present but unprivileged user namespaces disabled falls through to the weaker tier rather than claiming a control it cannot deliver — the rule `assertIsolation` already enforces.

The interpreter's own prefix is bound read-only, because a Node installed outside the distribution's packages is otherwise not there at all, and the failure reads as a broken command rather than as the sandbox working.

`SANDBOX_ENVIRONMENTS` is now exported: the tier list was spelled out by hand in a doctor test, which broke on the first tier added after it was written.

Nothing changes on macOS, where `macos-seatbelt` already reported `filesystem: true`, or on hosts without `bwrap`.
