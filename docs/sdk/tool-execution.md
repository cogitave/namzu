---
type: Reference
title: Tool execution ordering
description: Opt-in batch barriers, concurrency, cancellation and nested dispatch ordering.
resource: packages/sdk/src/runtime/query/executor.ts
tags: [sdk, tools, execution]
status: stable
---

# Tool execution ordering

## Classifying an operation

`DefineToolOptions.readOnly` accepts either a boolean or a typed input predicate,
matching `ToolDefinition.isReadOnly(input)`. Invocation preparation validates and
normalizes arguments before authorization and execution. Return true only for
explicitly recognized observation operations; metadata consumers may probe an
empty input, which must remain conservative for a mixed-purpose tool.

The built-in `job` tool classifies `read` and `list` as observations, while `kill`
remains mutating and destructive. Its static `shell_execute` permission describes
the complete capability. Per-call review, read-only authorization and plan-mode
execution use the operation predicate; provenance checks remain unchanged.

## Ordering a batch

`ToolDefinition.executionBarrier` and `defineTool({ executionBarrier: true, ... })`
opt a tool into ordering within a direct model tool-call batch. All earlier calls
settle before the barrier starts, and later calls wait for the barrier to settle.
Results remain in the model's original call order. For `[read, read, write,
read, read]`, making `write` a barrier lets each pair of reads overlap while
ensuring the second pair sees a successful completed write.

The default is absent/false. `concurrencySafe: false` still serializes a tool
against other unsafe calls; concurrency-safe calls may overlap that chain.
`concurrencySafe: true` still permits bounded parallel execution between barriers.
A barrier takes precedence over either concurrency setting. SDK builtins keep
their existing defaults; hosts can register `{ ...tool, executionBarrier: true }`
to opt selected mutation tools into ordered verification. Wrappers and registry
copies must retain this metadata.

A barrier orders settlement, not success. Failed, denied and recovered calls
retain the boundary; subsequent calls can inspect unchanged or partial state.
Unexpected executor/host rejection prevents dependent execution. Cancellation
before a queued call starts prevents its tool body from running. Each execution's
deadline starts when it executes, excluding time waiting behind a barrier.
Existing deadline abandonment still applies: a tool ignoring its abort signal
may continue external effects after its timeout result. Barriers provide no
rollback or guarantee that an uncooperative operation has stopped.

The scope is one direct batch, not a global lock across runs. Nested dispatches,
including `run_code` calls, belong to the enclosing execution and are not queued
on the enclosing batch's barriers. The enclosing executor closes and drains
admitted nested dispatches before reporting settlement. Mark the enclosing tool
as a barrier to isolate it from direct siblings. Inside a program, explicitly
`await` a mutation before dispatching dependent reads; a nested tool's barrier
metadata does not turn `Promise.all` into a sequential program.

## Presenting observations

A generic `ToolCallView` may set `activity: 'exploration'` alongside `presentation: 'activity'`. This is an optional host presentation hint for observations, not an authorization or execution policy. Namzu CLI groups successful annotated calls and keeps their output expandable; errors use the normal failure view. The built-in read, grep and glob tools publish this hint. Custom tools without it retain their existing presentation.

Built-in grep accepts a single regular-file path as a one-entry search. The local and guest file walkers match the root file's basename against the include pattern and never enumerate its siblings. The same cancellation, symlink and size checks remain in effect.

## File write receipts

The built-in `write` reports the operation observed during execution in
`ToolResult.data.fileChange`: `operation` is `create`, `replace`, `unchanged`,
or `write` when the sandbox could not establish the previous state. `unchanged`
means unchanged content; the write may still update file metadata. It includes
UTF-8 `bytes` and a full `sha256` of the submitted body; the existing `size`
field remains a JavaScript character count. These describe a successful write,
not an independent read-back verification or a cross-process transaction.

When previous state is known, `added`, `removed`, `newlineChanged` and `preview`
describe the differing region after trimming equal prefix and suffix lines.
This is a contiguous replacement preview, not a minimal multi-hunk diff.
A final newline terminates a line; an actual extra blank line is counted.
The optional `ToolCallView` diff `label` supplies an operation summary while
`path` retains the file path. CLI renders completed write receipts as diffs.

Before execution, `write` does not claim the target is new: its call view names
the path, and the CLI approval shows the full proposed replacement body with
an overwrite notice. Permission policy remains conservative: writes can replace
content and keep their destructive classification. Existing read-before-write,
freshness, containment and mutation-lock checks are unchanged. A sandbox read
failure without a typed ENOENT remains unknown rather than being reported as a
new file. This release does not add an atomic prepare/review/commit protocol
across sandbox backends or guard against external writers after admission.


`tool_completed.presentation` optionally carries the executor-produced diff to
hosts, including nested dispatches. The executor omits it on failed, truncated
or post-hook-overridden direct results and when its serialized size exceeds
`maxToolOutputChars`. Presentation failure never changes the mutation result.
Hosts can fall back to the retained result text when the view is absent.

## Reusing available evidence

When a tool result is shortened, its retained-output path identifies the saved
observation, not the original input. The SDK directs recovery through available
host-authorized tools without assuming that workspace `read`/`grep` tools can
access internal storage. A fresh observation cannot recover earlier contents.
Hosts with conversation search supply their specific recovery route. The notice
does not grant access, guarantee recovery, or replay the original action; it
shares the existing preview cap and may be shortened at very small limits.
Previously recorded previews keep their original text.

The coding-agent doctrine distinguishes successful tool observations from
intentions, failures and unverified reports. A successful write's exact input
is usable prior content on a later turn; the doctrine no longer demands an
unconditional read before every edit. Missing, partial or invalidated evidence,
external changes, freshness-sensitive actions and project/tool requirements
still call for a targeted observation. Exact-match edit failures require
inspection and replanning rather than forcing stale content onto the file.
Source selection also follows the question's time: an earlier observation or
its retained original can answer a historical question, while a fresh read of
a changed file cannot establish its past contents. Missing historical details
must be reported as unavailable rather than replaced with current values.
This generic rule does not assume that a host provides a history search tool;
capability-specific retrieval instructions belong to hosts that mount one.
Reported identifiers must keep their exact spelling, including case and
diacritics, rather than being translated or normalized with surrounding prose.
This is provider-independent model guidance, not a cache, permission grant or
promise that the model will never choose an extra read. Conversation replay
continues to carry complete tool arguments and results when not compacted.


## File changes between observation and edit

`edit` compares an available content fingerprint before applying any operation,
even when the requested anchor still matches. A difference refuses the edit
without writing and asks the model to read the current file before replanning.
This applies to both host files and sandbox files. Successful sandbox edits,
like host edits and writes, advance the observation to their resulting content.
An unchanged byte count does not bypass the content-hash comparison.

SDK hosts can pass a `createFileReadTracker()` instance as `query`'s
`fileReadTracker` option across multiple turns. Without it, the executor creates
a run-local tracker. Keep instances isolated by conversation and filesystem;
do not share observations between independent agents or unrelated sandbox roots.
The tracker retains hashes and path membership, not file contents. It is not
an inventory of what the model currently sees. A missing fingerprint remains
unknown; custom boolean-only trackers retain their earlier behavior.

A successful built-in full-body write calls `recordRead(key, content, toolUseId)`.
The optional third argument records the execution witness returned by the
optional `FileReadTracker.writeCallId(key)` method. Transparent tool wrappers
can preserve this evidence by forwarding the original `ToolContext`; a name
or a successful result alone cannot supply it. An identical later observation
preserves the witness; a changed or unknown observation clears it. Custom
trackers may omit this method and retain their existing mutation checks.

A successful built-in edit calls the optional `recordEdit(key, content, toolUseId)`
instead, and `recordRead(key, content)` where the tracker does not implement it
or the call has no id. `recordEdit` advances the observation the same way, and
additionally appends the call to the path's chain — but only where the ledger
already held a fingerprint for the content this edit ran against and a write
witness beneath it; otherwise the chain is cleared and the observation stands
alone. `editChain(key)` reports that chain as `{ rootWriteCallId, editCallIds }`
and is defined exactly when `writeCallId(key)` is not, because an edited body is
no longer the write call's body. A full-body write starts a fresh chain, and a
later observation that clears the witness clears the chain with it.

A successful built-in `read` that returned the file WHOLE calls the optional
`recordFullRead(key, content, toolUseId, renderedFingerprint)`, and
`recordRead(key, content)` where the tracker does not implement it or the call
has no id. It advances the observation exactly as `recordRead(key, content)`
does — always with the whole file, never the window — and additionally records
that the body is visible in that call's receipt. `renderedFingerprint` is of the
tool's own `output` string, not of the body: the body survives only as the
line-numbered rendering the receipt carries, so a consumer checks the receipt it
can see against this before referencing it. `readWitness(key)` reports
`{ callId, renderedFingerprint }`. A windowed read never calls this — a window
proves nothing about the rest of the file — and the witness is recorded only
where no write witness or chain survives the observation, because a write-rooted
body is one the model composed and the chain can be replayed onto. It is cleared
by exactly what clears a write witness, and additionally by any `recordEdit`: a
read roots no chain, so there is nothing to carry the body forward through an
edit. Trackers may omit both methods and keep their existing behavior.

A mutation refused for drift — `edit` on either branch, and `write`'s
fresh-overwrite check — calls the optional `recordDriftObserved(key)` before it
returns the refusal. That branch has just read the real file, so it is the one
place the disagreement is known for free; it records no body, because writing
what it read would re-baseline the very comparison that refused. The flag leaves
`fingerprint`, `hasRead`, `writeCallId`, `editChain` and `readWitness` exactly as
they were, so the next mutation is refused on the same comparison, and any later
observation clears it. `driftObserved(key)` reports the flag, which is how the
[derived work context](step-context.md#derived-work-context) stops referencing a
body it has been told is behind disk without a filesystem check of its own.
Trackers may omit both methods and keep their existing behavior.

A later `recordRead(key)` without content clears the old fingerprint and witness while
retaining path membership. Unknown newer content cannot establish that an older
body is still the latest observation. The runtime's [derived work context](step-context.md#derived-work-context)
can reference a successful write's visible body when it matches this ledger;
that reference does not skip mutation-time disk checks.

The CLI shares a tracker between ordinary turns for each conversation within a
live agent session, and seeds it from that conversation's own messages the
first time a turn asks for it. A resumed conversation, a `--resume` or
`--continue` run, and a fork all arrive as a conversation the process has not
served before, so each is seeded from the history it was given and never from
another conversation's. The ledger itself is still not persisted: nothing is
written to a session store, and a restarted CLI rebuilds what it can by
replaying the transcript rather than by reading a ledger back.

`seedObservationLedger(messages, tracker, { workingDirectory, additionalDirectories, sandboxed })`
is that replay, exported for a host that keeps a tracker per conversation and
has just restored one. It walks the history under the same visibility rules and the
same bounds the [derived work context](step-context.md#derived-work-context)
applies — one implementation, so a path one of them establishes is a path the
other admits. A `write` whose call and successful receipt are both intact
restores its body and its witness, and the `edit` calls above it are replayed
hop by hop to restore the chain. A `read` never supplies a body: the line
numbering is not undone to recover one. It can only settle a body already
reconstructed, by rendering that body forward through the read tool's own
renderer and comparing the whole rendering against the receipt — so a read
showing exactly that body keeps the witness, and a read that was windowed, that
shows something else, or whose receipt compaction cleared withdraws it. On the
mutation side a cleared receipt, a hop that no longer applies, a body past the
bounds and a call whose arguments run past what a replay reads as evidence each
withdraw whatever the pass was holding for that path, and so do the two cases
where the transcript settles no outcome at all. A call it never answered —
including the unknown-outcome result the runtime's own repair writes for one —
may have landed with the file half written, and nobody can say. A mutation it
refused is a tool's own report about that path, a drift refusal above all, made
after reading the disk and finding the body this ledger holds is not the body
there; restoring that fingerprint would undo a safety observation the transcript
is still carrying in words. A call a `pre_tool_use` hook SKIPPED withdraws the
path too, and is the one refusal that does not arrive as an error: the hook
declined the call, so nothing failed and the receipt is an ordinary success. It
is recognised by the sentence the runtime writes for a skip, through the same
function that writes it, because a skipped `write` read as a successful one
would restore a body that never reached the disk and have the next edit refused
for a drift the ledger itself invented. Each of those costs the path it names
and no other.

Replay reads no file's CONTENT; every body it restores is one the visible calls
rebuild exactly. The one thing it does touch the filesystem for is the key each
entry is filed under. A ledger entry identifies a file, not a spelling, so
`read`, `write` and `edit` all key on the path canonicalized through its
symlinks — and a seed has to file its entries where those tools will come
looking, or the fingerprint it restores is one no mutation ever checks and no
drift refusal can ever withdraw. So the paths named in the history are resolved
the way the tools resolve them, before the walk; a path that no longer resolves
inside the directories this run may reach is left unkeyed, and the mutation that
named it stops the pass rather than being filed somewhere approximate. Under a
sandbox the keys are the paths as written, as they are for the tools, and no
host path is consulted. That flag describes the run doing the seeding rather
than each turn in the history: a conversation whose earlier turns ran without a
sandbox and is resumed into one is keyed in the space its current tools use, so
the fingerprints it restores describe the other filesystem's files, and the
first mutation of each path is where that is caught.

A fingerprint restored this way is a claim derived from history, and the
mutation checks above still compare it with the real file before anything is
written: a file changed while the session was closed is refused there, and that
refusal's drift flag withdraws the path from the projection.

Content-backed observations, and only those. A path whose body could not be
reconstructed is left OUT of the ledger rather than entered without a
fingerprint: `hasRead` is the read-before-overwrite refusal, and granting it with
no body to compare would admit a full overwrite of a file that may have changed
while the session was closed. A seeded ledger is therefore never weaker than the
empty one a resume starts from — every path it does not restore behaves exactly
as it does with no seeding at all. A path the conversation only ever READ
establishes nothing either, because a window proves nothing about the rest of
the file.

Three things seed nothing at all, each leaving the conversation the empty ledger
it has always had. A history naming more than 1,024 distinct path spellings —
the ones only `read` names included, and two spellings of one file counting
twice — which is resolved whole or not at all rather than in a prefix that
cannot say what a mutation replaced. A tool call id claimed by two calls or
answered by two receipts — `read` included, because the receipt that was hidden
could be the observation that withdrew a claim. And a mutation no path can be
recovered from, whatever the transcript says came back to it: one declaring no
`path`, one whose path no longer resolves inside the directories this run may
reach — a refused write to a path outside them is one of these, since a key is
what withdrawing one path rather than the whole pass takes — or one the provider
stream cut off mid-JSON, whose arguments are recorded as `{}` with the raw
buffer kept only as `metadata.partialArguments`, what the model was saying
rather than what ran. A merely LARGE call is none of these: the argument bound
governs what may be believed, not what may be attributed, so an oversize `write`
withdraws its own path's body and leaves every other witness in the conversation
standing. Attribution is not unbounded, though — it is reading JSON, and for a
`write` the string being read is a whole file body. Each call's path is read at
most once per seeding and never at all past about a megabyte of arguments, some
thirty times the evidence bound: an oversize-but-ordinary write stays
attributable and the pathological one is a mutation that can be placed nowhere,
which is the third case above.

`resumeRun` and `query`'s checkpoint path do the same for a run, from the
history as repaired rather than as checkpointed, so the ledger describes what
the model is about to be shown — plus whatever of an owned resume turn already
ran. That turn is held out of the repaired history because the resume plan still
owns it, and it is put back at the end; but the plan does not merely re-append
it, it EXECUTES the calls in it that never started, and those tools read this
ledger. So the seeding cannot wait for the turn to be re-appended — it would
refuse the very write the resume exists to carry out — and folds in instead
exactly the calls a completed scan recovered an outcome for. A recovered `write`
restores what it put there; the unknown-outcome result written for an
interrupted one withdraws the path; and a call the scan proved never started is
left out, because the file it names is untouched and it is about to run. A
seeding that fails does not fail the resume: the run continues with the empty
ledger it would have had, and says so at debug. Shell writes and third-party
tools that do not record observations are outside this contract.
The runtime checks the body read at admission, under its own mutation lock; an
external writer can still race after that read. This is not filesystem-level
compare-and-swap or continuous file watching.

`runtime/query/__tests__/file-observations-cross-turn.test.ts` exercises a
successful write, a same-size external change, refusal on a subsequent query,
and successful recovery after reading current contents. The builtin stale-file
suite also covers sandbox drift, matching anchors and successive own edits.

## Recovery after an interrupted effect

`resumeRun` distinguishes a tool that completed from one that merely started.
If a command changed external state but the process died before recording its
result, its outcome is unknown. The runtime answers that checkpointed call with
an explicit unknown-outcome result and does not automatically execute it again.
Completed results are reused; calls proven not to have started can continue.
A model may then inspect current state before deciding on further work. This is
not an exactly-once guarantee for arbitrary external systems.

`RunStore.readToolExecutions?(toolUseIds, signal?)` returns a
`ToolExecutionSnapshot`: `complete` and selected `records`, keyed by call ID.
Each `ToolExecutionRecord` has `status: 'started'` or `status: 'completed'`;
a completion includes its result/error fields. A later start supersedes an
older completion, so an interrupted retry is not mistaken for its earlier
attempt. IDs must identify calls uniquely within the run. The runtime checks
the requested ID and tool name before reusing a record.

Disk recovery scans only the JSONL metadata, without loading retained outputs
or compaction attachments: 64 KiB reads, at most 256 MiB per log, 4 MiB per
record and 4,096 selected IDs. It validates run ownership, sequence, UTF-8 and
source stability. An incomplete final fragment makes the snapshot incomplete;
other malformed records, exceeded bounds and unavailable sources are refused.
Retrieval does not repair the log. Normal execution-store initialization retains
its existing torn-tail repair behavior when resuming a writer.

For stores without the optional method, the runtime validates a strict
`readEvents` result. That fallback inherits the custom store's read/allocation
costs; it does not provide the disk scanner's I/O bounds. Missing, incomplete or
contradictory execution evidence yields unknown outcomes rather than permission
to repeat calls. Cancellation propagates.

An explicit answer to a validated durable question owns re-entry of that
question's tool, even if its event store is unavailable. It does not authorize
re-entry of interrupted siblings. Tools using `requestPause` must make their
own pre-pause work safe to re-enter; a question answer cannot undo an external
effect. An ordinary tool approval does not override a recorded unknown outcome.

## Repeat-call advisory

`RepeatCallTracker` (`runtime/query/repeat-call.ts`) watches every tool call by
`(name, stableStringify(input))` and is enabled by default (opt out with
`repeatCallAdvisory: false`). At `notifyAfter` identical calls (default 3) it
attaches a mild note; at `escalateAfter` (default 5) the wording escalates.
Neither ever refuses: polling for a long-running job to finish is the same
call by design, so a repeat that keeps succeeding is only ever noticed. A
repeat that keeps FAILING identically is different — after
`refuseFailedAfter` consecutive identical failures (default 4) the next
identical call is refused instead of run; a success resets that count.

Delivery rides the last `tool_result` of the settled batch, the same slot
steering notes use, appending the advisory text to that result's content —
when that content is a plain string. A structured result (an image, a
document, an MCP resource block) has no string slot to append to, so the
advisory instead arrives as its own message immediately after the complete
tool-result batch, carrying `runtime-context` provenance
(`{ type: 'runtime-context', kind: 'repeat-call' }`) rather than an empty
`source`, so it is never mistaken for operator input on export, resume or in
a previous-prompt editor.
