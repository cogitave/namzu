---
"@namzu/sdk": patch
---

Stop the package README promising filesystem isolation the sandbox refuses to claim

The README that ships inside this tarball — and therefore the page on the
registry — said tools run "inside an OS-enforced jail with deny-default file
I/O", and attributed that to both sandbox tiers.

`src/sandbox/isolation.ts` says otherwise, and says it deliberately. The
namespace tier reports `filesystem: false`, because it unshares the mount
namespace and never remounts anything, so the child still sees the whole host
filesystem. The comment beside that table is explicit that claiming otherwise
would reintroduce the exact defect the table exists to end.

So the code was careful and the README was not, in the one direction that
costs something. An overclaimed security control is worse than an absent one:
a reader who believes a boundary is there stops looking for one, and this
sentence was reachable from the registry page by anyone deciding whether it
was safe to run untrusted input through a tool call.

Nothing about the runtime changes. What changes is that the README now
reproduces the isolation table per tier, names the tier that does **not**
enforce filesystem isolation and why, and points at `assertIsolation`,
`isolationOf`, `missingIsolation` and `describeIsolation` — which have always
been exported, and which refuse a run whose required control the host cannot
supply rather than quietly running it at a weaker tier.

No action required on upgrade. If you read that sentence and concluded your
tool calls were filesystem-confined on a namespace host, they were not — call
`assertIsolation` with the controls you actually require, and it will refuse
rather than pretend.
