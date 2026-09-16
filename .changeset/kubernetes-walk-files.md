---
'@namzu/sandbox': minor
---

`walkFiles` is now implemented on Kubernetes task sandboxes and on
`KubernetesWorkspace`, and the shared sandbox conformance suite gains three
sections.

The SDK's `glob` and `grep` builtins refuse any sandbox that omits
`walkFiles`, and both are in the default builtin set — so a host that
registered them and moved from the Firecracker or docker backend to Kubernetes
lost both tools with no change on its own side. It no longer does. Nothing
about the guest wire protocol changed and no new agent op was added: this is
the SDK's own `walkFilesViaExec` running the SDK's walk program through the
existing `execute`, the same way the Firecracker and docker backends have
always done it, so all three answer a search identically for one tree. The
shipped guest image needed no change either (`node:22-bookworm-slim`; the
agent is itself node).

The walk is an execution. It counts as busy for its whole duration rather than
per entry, `options.signal` and breaking out of the iterator both terminate the
guest's walk process, and a cancellation the guest cannot confirm retires the
sandbox exactly as a failed `exec` cancel does. On a workspace it passes the
same admission gate as every other data-plane call, so a suspended workspace
refuses a walk with `KubernetesWorkspaceSuspendedError` naming `walkFiles`,
exactly as it refuses `readFile`, without dialing anything.

`SANDBOX_CONTRACT_VERSION` moves from `2` to `3`: `defineSandboxConformance`
now also covers `walkFiles` (`maxEntries`, `maxDepth`, `includeHidden`, a
missing root, symlinks not followed, `ERR_FILE_WALK_LIMIT` on an exhausted
budget, and a refusal once destroyed), several `exec` calls at once on one
sandbox with no cross-talk between their results, and an `exec` whose `timeout`
produces a timed-out result and really terminates the command. A backend author
running the suite should expect the new cases; `walkFiles` is optional on
`Sandbox`, so a backend that omits it skips that section rather than failing
it, and no new case needs a guest feature that did not already exist.
