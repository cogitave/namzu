---
type: Reference
title: Context and compaction in the CLI
description: The file-only compaction key that picks the kernel's strategy or overrides the model's window, and the /context command that shows what compaction has done in a session.
resource: packages/cli/src/config/schema.ts
tags: [cli, compaction, config]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# Context and compaction in the CLI

# `/compact` and original history

In a recorded conversation, `/compact` retains removed original messages before
installing or saving the summary. This includes user-provided details omitted
from the summary. They remain searchable through `search_conversation` and
readable through `read_conversation`, including after restart.

The host writes a separate zero-model maintenance record in the conversation's
`runs/` directory, using the SDK run store and authenticated text index. It has
`agentId: manual-compaction`, `provider: host`, `model: none`, zero iterations
and zero model tokens; each removed message has a `compaction_shed` event with
`reason: manual`. It adds no assistant answer, checkpoint or global run-index
entry, and does not reopen a completed model invocation. Verifier usage, if any,
remains in the compaction result shown by the UI.

If retention fails or is cancelled, the replacement is not published. The TUI
shows the error and continues to use the original history. Large serialized
messages use the SDK's retained compaction storage instead of exceeding the
index's 4 MiB JSONL record limit. Private conversation ownership, scope, read limits and
text-only search rules apply to these records too. Archive timestamps identify
the copy, not when the user originally supplied the fact.

Archiving and replacing the conversation are ordered operations, not one
cross-store transaction. If replacement subsequently fails, the archive can
contain an extra copy while the original history remains active. Stateless
embedded sessions have no conversation archive and retain their existing
in-process behavior. A no-op creates no archive.

Automatic compaction uses the same disk encoding for large removed histories.
Search can recover text from a message carrying a large attachment without
loading the attachment. Full SDK event readers reconstruct the original message;
see [large compaction records](../sdk/retained-tool-evidence.md) for archive limits
and the raw JSONL storage shape. Oversized archival failures still preserve the
history, but 3 MiB is now an offloading threshold rather than the previous manual
compaction refusal limit.

# The `compaction` key

In `namzu.config.json` (project) or `~/.namzu/config.yaml` (user), never from the environment:

```json
{ "compaction": { "strategy": "salience", "contextWindowTokens": 200000 } }
```

| Field | Meaning |
| --- | --- |
| `strategy` | `salience` (the default), the scored working set described in [The salience-scored working set](../sdk/salience-working-set.md), or `structured`, the previous behaviour: positional retention and a pass only at the trigger. |
| `contextWindowTokens` | The window the kernel measures fullness against, when the model's table entry is wrong or a project wants compaction earlier. Absent, the kernel resolves it from the model. |
| `deduplicateObservations` | Enabled by default. Repeated identical read-only text observations share one full result in each model request. Set `false` to preserve the previous representation. Tool execution and canonical history are unchanged; see the [SDK policy and limits](../sdk/salience-working-set.md#exact-repeated-observations-in-the-active-request). |
| `retainedToolPreviewChars` | Nonnegative safe integer; default 4,000 in recorded conversations. Limits the preview of overflow text only after full text and its integrity manifest are saved. Set `0` to keep the previous 40,000-character preview budget. The spill threshold, smaller results and independently supplied model text are unchanged. |
| `recallEvidence` | Optional boolean, default `false`. Retrieve bounded historical passages from this recorded conversation before each model request; see the limits below. Independent of project-memory recall. |
| `consolidate` | `true` selects one consolidated `learning` entry per run instead of the default extracted-claim promoter. Both write to the project's structured memory store. Omitted or `false` uses promotion; it does not disable durable memory. |

The CLI uses one of these writers per run, including resumed runs. Retrieval is
separate: [structured memory](../sdk/memory.md) describes the records and tools;
`memory.recall: false` disables automatic per-step recall while retaining the
explicit memory tools and the selected writer.

A strategy is a property of a project's runs, which is why the key is file-only, like `hooks`.

The retained-preview policy applies to new output in ordinary recorded turns
and resumed runs, including nested tool receipts. It does not rewrite older
history. Stateless sessions and delegated workers keep their previous defaults.
Failed retention or an undersized recovery-pointer allowance preserves the
ordinary budget. Exact originals remain available through
[conversation evidence search](conversation-evidence.md); see the
[SDK retention contract](../sdk/harness-invariants.md) for text/rich-channel
boundaries. A short preview is an excerpt, not the complete output.

# Automatic historical evidence

Set `compaction.recallEvidence: true` to enable the experimental
[SDK evidence recall step](../sdk/evidence-recall.md) in recorded CLI turns,
including resume and resident turns using the conversation host. Stateless
sessions do not gain archive access. The default remains off.

Each request scans at most four bounded pages, accounting at most 8 MiB of
source/metadata bytes across those pages, from this conversation only. Each
closed-history enumeration examines at most 100 run-directory entries. Enumeration is bounded, not
an exhaustive or chronological search of a large archive. Up to four ranked
passages occupy at most 6,000 added characters. A one-second deadline cancels
optional retrieval; source or ownership failures expose no cached passage.
Legacy transcript text is labelled as a preview. Authenticated retained output
keeps its source tool, error flag and exact event/byte reference.

The pass first visits at most two pages from the requesting invocation's live
writer, then uses the remaining page/read budget for earlier invocations.
Live search follows authenticated completed records, including originals shed
by compaction. The current run is excluded from disk enumeration, so a missing
live owner cannot silently fall back to reading an active transcript as closed
history. Unsupported capture and incomplete traversal remain incomplete.
When another page remains, recalled context supplies a `search_conversation`
call with an opaque `cursor` for the unfinished live scan and/or closed-history
scan. The model can continue directly from that position. Source bytes are
revalidated and the tool's normal page/read limits still apply. Live cursors
require the same requesting writer; they cannot fall back to closed history
after it ends. An incomplete empty scan is explicitly reported even without a
selected passage. Automatic passes themselves still start at the current source.

The live continuation retains earlier preview/unavailable omissions from its
automatic scan. Exhausting the next pages clears the “more pages” condition,
not an already observed omission. A healthy scan can finish as complete;
missing evidence in a different history scan does not taint that live cursor.

Explicit `search_conversation`/`read_conversation` provide further pages and
exact text after compaction. New searches still use a literal query; cursor-only
continuation restores its host-owned query. Automatic passages are historical context, not a new user message or
proof of current workspace state. The feature neither reads the current
workspace to infer its past nor replays a state-changing action.

# `/context`

The short report shows the latest context token count, window size and
percentage, followed by cleanup passes and estimated tokens freed this
session. It labels whether the token count was measured by the provider or
estimated by Namzu, and whether the window was declared or assumed. An
approximate percentage is marked with `~`; missing measurements are reported
as unavailable rather than zero.

`/context details` adds the strategy and thresholds, the number of tool results
cleared, messages shortened and summaries written. `salience` starts reducing
less useful content at its soft target and summarises older history at its
trigger; `structured` clears older tool results at its trigger and summarises
when needed. Every completed pass also leaves a `⌫` row in the transcript.
These cleanup counters cover the session, while the context size is the latest
reported measurement and can fall after cleanup.

`/cost` reports tokens and own model-call cost for the current or latest run.
It does not accumulate every conversation turn and does not use token spend
as a context-fullness gauge. Delegated token usage, when available, is labelled
separately. `/cost details` shows pricing scope and any context measurement;
unknown prices, measured zero and partly priced usage remain distinguishable.
