---
'@namzu/sandbox': minor
---

A Kubernetes workspace command can now keep running when the connection
watching it is lost, and be picked up again by execution id — from this host
process or another one.

Before this, a command's output and result were tied to the one connection
that started it. Any socket reset made the host cancel the command to
reconcile, and a cancel it could not confirm within eight seconds retired the
pod, taking every open terminal with it. If the host process exited instead,
nothing cancelled at all: the command ran on, its output had been written only
to a closed socket and kept nowhere, and the only op that returned its record
terminated a running command to hand it over. A host that ran installs, builds
or test suites from a redeployable process had to hold every rollout until
nothing was in flight.

**Nothing changes unless you ask for it.** Without `executionId` and without
`detach`, `exec()` sends byte-for-byte the wire request it always sent, keeps
no output, and behaves exactly as it did. `SandboxExecOptions` is untouched, so
the SDK's exec contract and every other backend — the Firecracker tier
included — are unaffected, and `@namzu/sdk` is unchanged.

**What is new, all on the Kubernetes workspace handle.**

- `exec(command, argv, { executionId, detach, detachSignal, reattachWindowMs,
  onGap })`. When the exec connection fails, the handle reattaches from the
  last byte offset it received. Only getting back is bounded
  (`reattachWindowMs`, 30 s by default), and the bound is disarmed once an
  attach succeeds. If it cannot get back, `exec()` rejects with
  `KubernetesExecutionDetachedError`, carrying the `executionId` and the
  `outputOffset` to resume from. **It never sends a cancel to reconcile**, so a
  lost connection now costs the workspace nothing — no patch, no suspend, no
  pod. `signal` keeps its SDK contract and terminates; `detachSignal` ends the
  watching and leaves the command running.
- `attachExecution(executionId, { fromOffset, onOutput, onGap, signal })`,
  resolving to the same `SandboxExecResult`. It never signals the command:
  aborting its signal detaches. Every attach inside the retention window
  returns the same result. A refusal arrives as
  `KubernetesExecutionNotAttachableError`, whose `executionState` — when the
  guest reported one — tells the two answers apart that matter:
  `'reserved'` means the command never started, so nothing is running.
- `cancelExecution(executionId)`, the confirmed-cancel path from any process
  holding the id. A cancellation it could not confirm rejects and retires
  nothing.
- Exported: `KubernetesExecutionDetachedError`,
  `KubernetesExecutionNotAttachableError`,
  `KubernetesExecutionAttachUnsupportedError`,
  `KubernetesDetachedExecOptions`, `KubernetesAttachExecutionOptions`,
  `KubernetesAttachRefusal`.

**What you have to know before relying on it.** Starting the same
`executionId` twice runs the command once — but only while the guest still
holds the record. That ends at the retention window
(`NAMZU_AGENT_EXECUTION_RETAINED_TTL_MS`, 10 minutes) and at pod replacement,
which takes the whole registry with it; after either, the same id starts a
fresh command. A reader that asks for output the guest has already evicted is
told how many bytes it lost through `onGap`, and the result carries
`stdoutTruncated` and `stderrTruncated` — both, because the retained log is one
interleaved space.

**Redeploy the workspace image to get it.** The guest advertises
`execution-attach` in its `healthz` features and a host asking for a detachable
command against an older image is refused before the command is admitted. The
guest wire protocol version is deliberately **unchanged**, so no host and no
image has to roll together with this release.

**`NAMZU_SANDBOX_MAX_TIMEOUT_MS`.** The guest's ceiling on a caller's `timeout`
was a hard 30-minute constant; it is now read from this variable — the same one
the container worker has always read for the same limit — and named in the
refusal. The default is still 30 minutes, so an unconfigured deployment refuses
exactly what it always refused. Set it to run a suite longer than that without
rebuilding the image.

Four variables join the shipped workspace template's `env` block at their
defaults, so deleting them changes nothing: `NAMZU_SANDBOX_MAX_TIMEOUT_MS`,
`NAMZU_AGENT_EXECUTION_LOG_BYTES` (1 MiB of retained output per execution),
`NAMZU_AGENT_MAX_RETAINED_OUTPUT_LOGS` (32 executions retaining at once) and
`NAMZU_AGENT_EXECUTION_RETAINED_TTL_MS`. The last three bound what retention
can cost the container's 512Mi; only a command that asked for it retains
anything.
