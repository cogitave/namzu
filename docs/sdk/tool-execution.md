---
type: Reference
title: Tool execution ordering
description: Opt-in batch barriers, concurrency, cancellation and nested dispatch ordering.
resource: packages/sdk/src/runtime/query/executor.ts
tags: [sdk, tools, execution]
status: stable
---

# Tool execution ordering

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

The coding-agent doctrine distinguishes successful tool observations from
intentions, failures and unverified reports. A successful write's exact input
is usable prior content on a later turn; the doctrine no longer demands an
unconditional read before every edit. Missing, partial or invalidated evidence,
external changes, freshness-sensitive actions and project/tool requirements
still call for a targeted observation. Exact-match edit failures require
inspection and replanning rather than forcing stale content onto the file.
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

The CLI shares a tracker between ordinary turns for each conversation within a
live agent session. These observations are not persisted: restarting the CLI
or rebuilding the agent session (including model changes) starts a new ledger.
Durable resume does not restore this ledger from transcript text. Shell writes
and third-party tools that do not record observations are outside this contract.
The runtime checks the body read at admission, under its own mutation lock; an
external writer can still race after that read. This is not filesystem-level
compare-and-swap or continuous file watching.

`runtime/query/__tests__/file-observations-cross-turn.test.ts` exercises a
successful write, a same-size external change, refusal on a subsequent query,
and successful recovery after reading current contents. The builtin stale-file
suite also covers sandbox drift, matching anchors and successive own edits.
