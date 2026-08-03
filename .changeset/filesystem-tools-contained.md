---
'@namzu/sdk': patch
---

`glob`, `grep` and `ls` stay inside the working directory, and inside the
sandbox when there is one.

Two independent failures, both in tools that are in the default set.

**The path escape needed no sandbox at all.** All three resolved a
caller-supplied `path` against the working directory bare, so
`path: "../../.."` landed wherever that pointed and the tool read it
happily. The containment rule already existed — in one private function
inside the local sandbox provider — and these never reached it. `grep`
returns file **content**, so what escaped was not a listing. For `glob` the
same escape also rides in on the *pattern*, since the base directory lifted
out of `"../../**/*.pem"` is caller-supplied too.

A refusal now reaches the model as a failed tool result carrying the reason,
rather than a throw, so it can correct itself.

**The sandbox was not a read boundary.** `glob` and `grep` called
`node:fs/promises` against the host working directory and referenced
`context.sandbox` nowhere, while every sibling builtin already remembered
the branch. With a container backend wired in they read the SDK process's
own filesystem. The paths they returned were host-relative too, while
`read` resolves what it is handed *inside* the sandbox — so every
search-to-read handoff either failed or opened a different file. The two
roots genuinely diverge: the executor passes `workingDirectory` through
unchanged alongside the sandbox.

Both now route through `context.sandbox` when present. `grep` abstracts only
the file *source* — enumerate and read — so matching, context lines and the
caps stay one implementation; duplicating the substantive half is how the
two paths would drift, and the sandboxed one is the one nobody runs by
accident.

**Sandbox paths are no longer run through the host's path module.** A
sandbox is a POSIX filesystem whatever the host runs, so resolving its paths
host-side rewrites them whenever the two disagree — on a Windows host
`resolve('/workspace')` becomes `C:\workspace`, and a container path stops
being a container path. This was found by the new tests, which returned no
results at all until it was fixed.
