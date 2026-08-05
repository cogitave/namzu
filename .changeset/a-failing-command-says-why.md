---
'@namzu/sdk': patch
---

a failing shell command now says what happened, and its own deadline is the one that fires

**The failure path threw away everything useful.** The host branch of `bash`
called `exec` with no `catch`, and `exec` rejects on a non-zero exit. So the two
things an agent runs a shell for most — a test run and a build — both threw, the
registry turned the throw into "the tool failed", and the stdout, stderr and
exit code that explain why were discarded. The rejection carries all three.

The sandbox branch a few lines above already reported them, so the same command
told the model two different amounts depending on where it happened to run. It
now reports the exit code, both streams, and — separately — whether the command
ran out of time, because "timed out" and "exited 1" lead to different next moves
and the model acts on the message.

A caller-owned abort still propagates as an abort rather than being reported as
a command failure.

**Two clocks, one of them undeclared.** `bash` enforces the `timeout` it is
given; the executor enforces a separate per-tool deadline, and with none
declared here it fell back to its generic default — also two minutes. The two
agreed by coincidence and diverged the moment a model asked for longer because
it knew a build was slow: it got two minutes, from a clock it had not been told
about, reported as an abandoned tool rather than as a command that ran out of
time.

The tool now declares a deadline above the ceiling its input accepts, so its own
clock is the one that fires. A request past the ceiling is **refused** rather
than silently clamped — a number the model was not told had changed is how it
learns to distrust its own arguments. The ceiling is ten minutes, overridable
with `NAMZU_BASH_MAX_TIMEOUT_MS`.

**And it now has tests.** The only builtin that runs a shell had none, which is
how the swallowed failure shipped. Thirteen cases, mutation-checked: neutralising
the failure path fails four of them.
