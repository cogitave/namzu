---
'@namzu/cli': minor
---

Add `/status`, which shows where a run may write and when it stops to ask, on one page.

Both facts were already there and neither was findable next to the other. The sandbox arrives as a boot notice that scrolls away; the approval settings answer to `/permissions`. They are separate mechanisms answering separate questions, and neither implies the other — turning approvals off widens no sandbox, and confining the filesystem stops no prompt. Read apart, each looks like the whole answer, which is exactly how an operator ends up believing they configured something they did not.

`/status` prints them adjacently, each labelled with the question it answers rather than with its mechanism's name, along with the provider, model and spend.

Two things it refuses to smooth over. A tier that enforces nothing is reported as **not confined** rather than as a weaker sandbox, because it is the absence of one. And what the config *demanded* is printed separately from what the host *happens* to supply: those read identically on a machine that supplies it anyway, and only the demand still holds on the next machine.

`ResolvedSandbox` gained the structured facts behind its notice (`environment`, `enforced`, `required`), and `AgentSession` carries a `SandboxSummary` so a caller reads the sandbox the run is actually using rather than resolving a second one.
