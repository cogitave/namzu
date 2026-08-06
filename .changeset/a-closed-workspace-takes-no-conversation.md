---
'@namzu/cli': patch
---

A workspace its owner closed takes no new conversation from the CLI either

The kernel gained a workspace-closed gate: an archived `Project` accepts no new
session, enforced at the SDK's own ingress paths. The CLI's conversation store
calls `createSession` on the store **directly**, and a store deliberately holds
no view of workspace status — so the invariant did not reach here, and namzu
kept attaching work to a workspace somebody had deliberately closed.

Whether that was real turned on one question: does the CLI ever reach a project
it did not just create? It does. `openSessions` reads the project id back out
of `.namzu/cli.json` and creates a new project only when that pointer is
missing or stale, so every run after the first attaches to a project that
already existed. A freshly created project is always open, which is why the
first run in a directory could never have shown this.

`startConversation` now calls `requireOpenProject` before creating the session,
and an archived workspace refuses by name.

The sub-agent runtime calls `createSession` directly too and is deliberately
**not** gated: its store is an in-memory one built four lines earlier, the
project two lines earlier, and neither outlives the runtime — so the id can
never be one an owner has closed. A check that cannot fail teaches the next
reader only that the checks here are decoration, so that site carries a comment
naming the condition that would make it real instead.
