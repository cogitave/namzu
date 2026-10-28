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

`/compact` takes optional text, `/compact keep the failing test names`. The text
is given to the model step of the summary as part of what to keep, and that step
runs even where the project has `llmVerification` off, because it is the only
step that can act on free text. Without text, `/compact` makes a model call only
for the small model's summary (see [Who writes the summary](#who-writes-the-summary)); with
`compaction.modelSummary: false` it makes none, as before. The text is cut to 2,000 characters.

In a recorded conversation, `/compact` retains removed original messages before
installing or saving the summary. This includes user-provided details omitted
from the summary. They remain searchable through `search_conversation` and
readable through `read_conversation`, including after restart.

A manual compaction runs between turns, never inside one: the host calls
`compactSession`, which appends to the conversation's session log a
`compaction` record with `trigger: 'manual'` and no turn id, beside one
`compaction_shed` event with `reason: manual` that contains the removed
messages in input order, matching automatic compaction. No model is called for
the record itself. When a conversation mounts `search_conversation` and
`read_conversation`, the summary ends with a pointer to them, and a cleared tool
result keeps its saved-file line with the sentence that says how to read it (the
`read` tool, or the conversation tools); see
[Getting at a saved output](conversation-evidence.md#getting-at-a-saved-output).
The SDK spills large arrays to `tool-results/` and the
session index covers each textual part. Raw record consumers must iterate
`messages`; use the returned `seq` and `part` when reading search matches. It
adds no assistant answer, checkpoint or turn, and is refused while a turn is
active. Verifier usage, if any,
remains in the compaction result shown by the UI.

What the transcript shows is deliberately short. While
a pass runs, the live area says `Compacting conversation…` with the spinner and
the clock (for `/compact`, and for every in-turn automatic pass: the SDK emits a
`compaction_started` event when the pass begins, and the row stays until the
pass completes, fails, or clearing alone made room). `/compact` then leaves `› /compact` and `✻ Compacted · 12 messages summarized · context about 190k to 20k tokens (ctrl+o to see
full summary)` where it ran (the sizes are estimates from the conversation's text and are left out when nothing got smaller), below the turns that stay; the summary, without the marker the model reads, opens with
Ctrl+O instead of sitting under the row. An automatic pass leaves `✻ Conversation
compacted (ctrl+o for history)`, and Ctrl+O shows what became what. A resumed
conversation shows the same row at the top. The rows kept after `/compact` start
on a prompt, never on an answer without its question. When there is nothing to
compact it says `Nothing to compact yet. The conversation is still short enough.`
A pass that cannot run says `Compaction failed · conversation could not be
reduced below the context limit` (or one plain sentence for the other causes);
the runtime's own error text follows only with `NAMZU_DEBUG=1` or `--debug`.
Tool-result clearing draws no row at all; its counts stay in `/context`.

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

# Who writes the summary

The summary is written by the small model (see [The small model for side jobs](small-model.md):
`smallModel`, else the cheapest text model of your provider), for `/compact`, `/compact <what to keep>`
and every automatic pass. It reads the part being replaced, with each tool result cut to its start and
end, and writes your requests in your own words, what was being done, and the next step. A model that is
not set aside, one that cannot be reached, a call that fails or runs too long, or a reply that has no
summary in it, all fall back to the summary Namzu extracts without a model, and the pass goes on. The
call's tokens are counted on the turn it belongs to (a `/compact` between turns is counted on the latest
turn). Set `compaction.modelSummary: false` to always use the extracted summary and make no model call
unless `/compact` was given text.

# After a compaction

A summary says that a skill was loaded and a file was read; it cannot give the next step the skill's instructions or the file's lines. So each pass puts the most recent of both back, verbatim, under `## Restored after compaction` at the end of the summary:

- the skills the conversation loaded, newest first, up to 8, at most 5,000 tokens each and 25,000 together;
- the files it read, newest first, up to 5, at most 5,000 tokens each and 50,000 together. Instruction files (`AGENTS.md`, `AGENTS.local.md`, rule files) and the plan file are not repeated, a file that was changed after it was read is left out because its text is behind the disk, and a read that failed has nothing to restore;
- the plan from plan mode, when there is one: where the file is and what it says now (cut at about 5,000 tokens).

The caps shrink on a small window: files may take at most a tenth of it and skills a twentieth, so a 100,000-token window restores about 10,000 and 5,000 tokens. A body that does not fit is cut and says so. What was restored survives a resumed session and the next compaction, and the model is told a file may have changed since it was read. `/compact` and `/compact <what to keep>` restore the same things.

# The `compaction` key

In `namzu.config.json` (project) or `~/.namzu/config.yaml` (user), never from the environment:

```json
{ "compaction": { "strategy": "salience", "contextWindowTokens": 200000 } }
```

| Field | Meaning |
| --- | --- |
| `strategy` | `salience` (the default), the scored working set described in [The salience-scored working set](../sdk/salience-working-set.md), or `structured`, the previous behaviour: positional retention and a pass only at the trigger. |
| `contextWindowTokens` | The window the kernel measures fullness against, when the model's table entry is wrong or a project wants compaction earlier. Absent, the kernel resolves it from the model. |
| `triggerThreshold` | The fraction of the window at which older history is summarised. Absent, the kernel derives it as the window less room for the reply (the model's output cap, at most 20,000 tokens) less a 13,000-token buffer, so about 83.5% of a 200,000-token window (167,000 tokens) and 96.7% of a 1,000,000-token one. It never drops below half the window. It was a flat 0.7 before; set `0.7` to keep that. |
| `deduplicateObservations` | Enabled by default. Repeated identical read-only text observations share one full result in each model request. Set `false` to preserve the previous representation. Tool execution and canonical history are unchanged; see the [SDK policy and limits](../sdk/salience-working-set.md#exact-repeated-observations-in-the-active-request). |
| `retainedToolPreviewChars` | Nonnegative safe integer; default 4,000 in recorded conversations. Limits the preview of overflow text only after full text and its integrity manifest are saved. Set `0` to keep the previous 40,000-character preview budget. The spill threshold, smaller results and independently supplied model text are unchanged. |
| `recallEvidence` | Optional boolean, default `true` in recorded conversations. Retrieve bounded historical passages from this conversation before each model request; see the limits below. Set `false` to disable automatic archive recall and its query-planning inference. Independent of project-memory recall. |
| `resolveEvidenceQueries` | Optional boolean, default `true` when `recallEvidence` is enabled. Resolve conversational references through a bounded, metered model call per operator input; set `false` for literal retrieval without preparation inference. |
| `consolidate` | `true` selects one consolidated `learning` entry per turn instead of the default extracted-claim promoter. Both write to the project's structured memory store. Omitted or `false` uses promotion; it does not disable durable memory. |
| `modelSummary` | Optional boolean, default `true`. Let the small model write the compaction summary; see [Who writes the summary](#who-writes-the-summary). `false` keeps the summary Namzu extracts itself, and the previous behaviour of `/compact` making no model call without text. |
| `idleCompaction` | Optional boolean, default `false`. Compact a large conversation nobody is using just before its one-hour prompt cache expires; see [Compacting while idle](#compacting-while-idle). |
| `idleCompactionMinTokens` | Positive integer, default 200,000; a value under 100,000 is raised to 100,000. The smallest context worth compacting while idle. The environment variable `NAMZU_IDLE_COMPACT_MIN_TOKENS` overrides it. |
| `promptCacheTtl` | `5m` (the default, the provider's own) or `1h`. How long the provider is asked to keep the prompt cache. Only a provider that can be asked takes it (the Anthropic driver, and the Bedrock driver for models of the 4.5 generation and later). A one-hour cache costs more for each write than a five-minute one, so the default is unchanged. `/context` shows the lifetime in use under the legend (only with a provider that can be asked), and `namzu doctor` has a `providers.cache-lifetime` row that reports it and, with the default, suggests `1h` for long sessions or frequent pauses of more than five minutes. |

The CLI uses one of these writers per turn, including resumed turns. Retrieval is
separate: [structured memory](../sdk/memory.md) describes the records and tools;
`memory.recall: false` disables automatic per-step recall while retaining the
explicit memory tools and the selected writer.

A strategy is a property of a project's sessions, which is why the key is file-only, like `hooks`.

The retained-preview policy applies to new output in ordinary recorded turns
and resumed turns, including nested tool receipts. It does not rewrite older
history. Stateless sessions and delegated workers keep their previous defaults.
Failed retention or an undersized recovery-pointer allowance preserves the
ordinary budget. Exact originals remain available through
[conversation evidence search](conversation-evidence.md); see the
[SDK retention contract](../sdk/harness-invariants.md) for text/rich-channel
boundaries. A short preview is an excerpt, not the complete output.

# Compacting while idle

A one-hour prompt cache is written once and read cheaply for an hour. Come back to a large conversation after it has lapsed and the whole context is written again at full price. With `compaction.idleCompaction: true` and `compaction.promptCacheTtl: 1h`, Namzu compacts the conversation shortly before the cache would lapse, so coming back re-reads a small context instead.

It is off by default and acts only when every one of these holds at the moment the timer fires, which is once per finished reply, 90% of the way through the cache's life since its last use (54 minutes for a one-hour cache):

- the provider reported a one-hour lifetime for the reply that just finished (a five-minute cache, or a provider that reports no lifetime, never triggers it);
- the timer is no more than a minute late, so a laptop that slept does not compact a cache that is already gone;
- the context holds at least `idleCompactionMinTokens`;
- no new request, turn, dialog, queued message or background work exists, and nobody has pressed a key for a minute;
- the conversation and model are the ones it was armed for.

A skipped or failed attempt shows nothing and is not retried. A successful one is recorded in the conversation log as an `idle` compaction and leaves one dim row:

```text
Compacted while idle, before the prompt cache expired · turn off with "idleCompaction": false under "compaction" in the config
```

A person who comes back while it is running sees the usual compacting state. No usage-limit signal reaches the terminal, so there is no check against one. Like any compaction it hides the footer's context meter until the next reply, and `/context` sizes the conversation from its messages until then. It does not run while the detailed transcript is open. It is a file setting and has no `/config` row: it needs the one-hour cache lifetime chosen when the conversation starts, so a change takes effect from the next start.

# Automatic historical evidence

Recorded CLI conversations enable the
[SDK evidence recall step](../sdk/evidence-recall.md) by default, including
resume and resident turns using the conversation host. It can supply historical
details missing from a retained preview or compacted history without requiring
the user to name an archive tool. Stateless sessions do not gain archive access;
the SDK itself still requires the host to install this step.

Set `compaction.recallEvidence: false` to keep the previous CLI default and avoid
automatic archive reads and query-planning inference. Explicit
`search_conversation` and `read_conversation` tools remain available. Project
memory's separate `memory.recall` setting does not disable conversation evidence.

When recall is enabled, `resolveEvidenceQueries` defaults to `true`. Short
follow-ups with preceding visible conversation may make an additional tool-free
model call to identify the subject of a historical question. Its terms must be
grounded in exact quoted conversation text. Self-contained/new-topic queries
keep their own terms; present-state questions are not expanded with historical
terms. This interpretation does not prove the final answer or file freshness.
See the [SDK planning bounds](../sdk/evidence-recall.md#selection-and-limits).

The preparation call shares the turn's model/provider chain, effort, token budget
and cancellation, with at most 512 output tokens and a ten-second deadline.
It is separate from the retrieval deadline below. Repeated iterations reuse the
plan for that input, but revalidate the evidence. Set
`compaction.resolveEvidenceQueries: false` to retain the previous local-only,
literal-query behavior and avoid the additional inference cost. This setting
has no effect when `recallEvidence` is off.

Planning and retrieval are optional preparation: invalid model plans, deadlines
or read failures are diagnosed so the main request can continue. When room
permits, a temporary availability note identifies the failed stage without raw
error text or a claim that history is absent. Failed planning can still use the
unchanged current-query tokens for bounded literal retrieval; its note remains
beside any fully validated records. It does not claim to have resolved a referent
or temporal intent. Failed retrieval supplies no evidence. Explicit archive tools remain usable;
an unavailable planner does not spend another planning call every iteration.
This is not a guarantee that the model will recover a missing detail or select
the right source. The [default-recall experiment](../../research/conversation-evidence/default-recall-results.md)
records the natural CLI control, inference usage and its limits.

Each request scans at most four bounded pages, accounting at most 8 MiB of
source/metadata bytes across those pages, from this conversation's session log
only. The read is bounded, not an exhaustive search of a long conversation. Up to four ranked
passages occupy at most 6,000 added characters. A one-second deadline cancels
optional retrieval; source or ownership failures expose no cached passage.
Text recorded only as a preview is labelled as one. Authenticated retained
output keeps its source tool, error flag and exact record/byte reference.

The pass first visits at most two pages from the requesting invocation's live
writer, then uses the remaining page/read budget for earlier turns.
Live search follows authenticated completed records, including originals shed
by compaction. The current turn is excluded from the settled-history pass, so a
missing live owner cannot silently fall back to reading an active turn as
settled history. Unsupported capture and incomplete traversal remain incomplete.
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

`/context` draws where the window goes. A grid of squares stands for the whole
window: 10 by 10 (100 squares), 5 by 5 on a terminal under 80 columns, and
20 by 10 for a window of a million tokens or more. Each category fills
`round(tokens / window x squares)` squares, at least one, in a colour of its
own. A category's last square is `⛁` when it is at least 70% full and `⛀`
below that; free space is a dim `⛶`; the auto-compact buffer, when it is
drawn, comes last as `⛝`.

Beside the grid: the model, `used/window tokens (percent)` (`42k/200k tokens
(21%)`, with a leading `~` when the size is an estimate), and one line per
category with its size and a one-decimal share. The categories, in order, are
System prompt, System tools, MCP tools, MCP server instructions, Custom agents,
Memory files, Skills and Messages, then Free space. A category with nothing in
it is left out. Messages is what is left of the provider's measured size once
the other categories are taken out, so the lines add up to the window.

When the provider lets the prompt cache lifetime be chosen, `Prompt cache lifetime: 5 minutes` (or `1 hour`) follows the legend.

The Autocompact buffer (the room kept for a reply plus 13,000 tokens, 33,000 on
a 200,000-token window) and an `Auto-compact window:` line appear only when the
window was set in the config or assumed for an unrecognised model. On a window
the provider or Namzu's model table declares, there is no buffer and free space
is the window minus what is used. When the context is past the window, a red
line says by how much and to run `/compact`.

Under the grid, each list that has something in it: MCP tools (`/mcp`), Custom
agents (`.namzu/agents/`, grouped by Project and User), Memory files
(`/memory`, one line per instruction file) and Skills (`/skills`, a rough size
rounded to ten, or `< 20`). Sizes are estimated from characters, except that
the total is the provider's own count when it gave one.

Advice follows, warnings first and then by how much it could free: context at
80% or more; a tool whose calls and results are at least 15% of the window and
10,000 tokens (shell, read, search and web fetch each get their own hint, any
other tool at 20%); file reads at 5% and 10,000 tokens; memory files at 5% and
5,000 tokens, naming the three largest. There is no advice once the context no
longer fits. Before the first reply, which is when the window is first known,
`/context` says there is no size yet.

The footer's notice slot also shows `N% until auto-compact` once the context is
within 20,000 tokens of the summary point. A compaction hides it until the next
turn starts; see [the composer footer](terminal-design.md#the-composer-footer).

`/context details` adds, under the advice, the strategy and thresholds, the number of tool results
cleared, messages shortened and summaries written. `salience` starts reducing
less useful content at its soft target and summarises older history at its
trigger; `structured` clears older tool results at its trigger and summarises
when needed. Every completed pass also leaves a `✻ Conversation compacted` row in the transcript, and a manual `/compact` counts as a pass here too.
These cleanup counters cover the session, while the context size is the latest
reported measurement and can fall after cleanup.

`/cost` reports tokens and own model-call cost for the current or latest turn.
It does not accumulate every conversation turn and does not use token spend
as a context-fullness gauge. Delegated token usage, when available, is labelled
separately. `/cost details` shows pricing scope and any context measurement;
unknown prices, measured zero and partly priced usage remain distinguishable.
