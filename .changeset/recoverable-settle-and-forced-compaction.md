---
'@namzu/sdk': minor
'@namzu/anthropic': patch
'@namzu/sandbox': patch
---

Five places where namzu gave up, or claimed to recover, too early.

**A transient failure now pauses instead of failing.** A 503 that survived
every in-turn recovery — retry with jitter, the one-shot compaction relief,
mid-stream salvage — settled the run as `failed`, identically to a bad API
key. The host could not tell them apart, and recovering meant knowing about
checkpoints and driving replay itself. The state was never the problem:
checkpoints are written every iteration by default and the failed run is
persisted with full messages. Only the settle and the signal were missing.

A retryable failure with a checkpoint to resume from now emits `run_paused`
naming that checkpoint, leaves the span OK rather than ERROR, and sets
`stopReason: 'paused'`. Both conditions are required — pausing on a
permanent error would invite a resume that cannot work, and pausing with
nowhere to resume from produces a run nobody can ever pick up.

**A forced compaction pass can no longer decline to do anything.** A forced
pass runs because the provider *rejected* the prompt as too long, and two
things let it treat that as advisory. It re-applied the chars/4 estimate
after clearing stale tool results — the estimate the provider had just
refuted — and returned early if that said the context was fine. And relief
reported success on ANY positive shed, so clearing one short result counted
and the retry burned a whole model call to be told the same thing. The
early return is now force-gated, and a shed has to clear a floor (a
fraction of the prompt, at least a couple of thousand characters) to count.

Separately, the relief latch is per **stuck point**, not per run. It exists
to stop a second overflow immediately after a successful compaction from
looping; as a run-scoped flag it meant one relief at iteration 3 disarmed
the mechanism for the rest of the run, leaving iteration 40 to die with
obvious moves left. It is now cleared by a turn that actually succeeded.

**An eval case can no longer hang the suite.** `executeCase` was a bare
await, so a `run` closure that never settled blocked its worker and
`runExperiment` never returned — no report, no partial results, nothing to
read. `ExperimentConfig.timeoutMs` bounds a case and hands `run` an
`AbortSignal` as a third argument; a timed-out case is reported and the
suite continues, exactly like a case that threw, with its real elapsed time
rather than zero. Unset means no deadline, which is today's behaviour. The
documented path already inherits deadlines from the runtime it drives; this
covers what those cannot see — a closure that does not go through
`query()`, and a mid-iteration provider stall.

**A malformed content block is named, not smuggled.** One driver built an
image block by calling `String()` on whatever `data` and `mediaType`
happened to be, behind only a truthiness check — so a non-string `data`
became the literal `"[object Object]"` as the base64 payload, and the wire
rejected the whole request with nothing naming the block at fault. That is
reachable: a remote tool result is cast without validation on the way in.
It now type- and media-type-guards and degrades to a named placeholder,
matching the sibling driver that already did, and without inlining the
payload it refused to send.

**Failures have somewhere to grow remediation.** A stale API key surfaced
as whatever prose the vendor SDK happened to write: no id to grep in logs,
no instruction on what to change, and no growth point — a newly-observed
failure shape could only be given curated copy by editing the classifier.
`explainError` adds an ordered, id-keyed rule layer matching on
**structural** signals (code, status, an explicit hint) rather than
volatile vendor prose. `run_failed` carries the result as `explanation`;
`withHint(err, '…')` lets a throw site attach what only it knows, and
outranks every generic rule. It returns `null` when no rule claims the
failure — inventing advice for something uncharacterised is worse than
saying nothing, because it sends the reader somewhere specific and wrong.
The container backend's readiness, port-mapping and worker-fetch failures
now carry hints.
