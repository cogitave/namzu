---
type: Reference
title: Hook events
description: The events the kernel fires for extensions and shell hooks, what each carries, which can answer with a verdict, and the JSON a shell hook reads on stdin.
resource: packages/sdk/src/plugin/shell-hook.ts
tags: [sdk, cli, hooks, plugins]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# Hook events

A hook is a function an extension registers on the plugin lifecycle manager, or a shell command a host attaches to the same manager through the shell hook adapter. Both see the same events with the same context.

## The events

| Event | Fired | Carries | Can answer |
| --- | --- | --- | --- |
| `session_start`, `session_end` | by the host: before the session's first turn, and when it closes | `sessionId`, and no `turnId`: these belong to the session, not to a turn | nothing |
| `user_prompt_submit` | by the kernel, before the model sees the prompt and before `turn_start` | `prompt`, `sessionId`, `turnId` | `skip` blocks the turn, which ends failed and names the reason; `annotate` adds text to the system prompt for the whole turn |
| `turn_start`, `turn_end` | at the edges of a turn | `sessionId`, `turnId` | `error` fails the turn |
| `turn_interrupt` | when a root session's turn is stopped by the user | `cancelCause` | nothing; every hook runs |
| `pre_tool_use` | before each tool call | `toolName`, `toolInput` | `skip`, `modify`, `error` |
| `post_tool_use` | after each tool call | `toolName`, `toolInput`, `toolResult` | `replace`, `retry`, `error` |
| `pre_llm_call`, `post_llm_call` | around each model call | `request`, `response` | `error` |
| `iteration_start`, `iteration_end` | around each iteration | `iteration` | `error` |
| `pre_compact`, `post_compact` | around a compaction pass once the check decided to run one | `compaction`: `reason` (`threshold` or `overflow`), `tokensBefore`, `tokensAfter` after, `contextWindowTokens` | `error` fails the turn |
| `subagent_stop` | after a child session's own `turn_end` | `parentSessionId`, `parentTurnId` (the parent turn whose tool call spawned it) | `error` fails the child turn's finalization |

`post_*` hooks run in reverse registration order, so a formatter registered last runs first after a write.

Every in-process hook may return `continue`. The other actions in the table
belong only to the listed event. `PluginHookDefinition` keeps the event and
handler result correlated, including when hooks are supplied as an array to
`definePlugin`. `PluginHookResultFor<Event>` names the accepted result type for
one event. A handler previously declared as returning the whole
`PluginHookResult` union should return the narrower result for its event.
`session_start`, `session_end` and `turn_interrupt` only accept `continue` as a
declared verdict: their returned values cannot decide a turn. The runtime
still checks JavaScript hook results independently; unsupported actions are
rejected by query hooks, while these three observational events ignore their
results.

Every hook context carries `sessionId`. `turnId` is present on every event
inside a turn and absent on `session_start` and `session_end`
(`PluginHookContext.turnId?`).

The events were named `run_start`, `run_end` and `run_interrupt` before
`@namzu/sdk` 44. A configuration or plugin that registers an old name is
refused when it is loaded, with a message naming the new one
(`RENAMED_PLUGIN_HOOK_EVENTS`, `assertPluginHookEvent`).

## Shell hooks

A shell hook is one command per event, run with `sh -c` in the working directory, with the event as JSON on stdin and a deadline (30 s by default, ten minutes at most). It may attach to `user_prompt_submit`, `session_start`, `session_end`, `pre_tool_use`, `post_tool_use`, `pre_compact`, `post_compact`, `subagent_stop`, `turn_start` and `turn_end`. The model-call and iteration events stay in-process: they carry the messages, and a shell is not where those go.

The stdin JSON always has `event`, `cwd` and `session_id`; `turn_id` on every event inside a turn (never on `session_start` or `session_end`); and when the event has them `prompt`, `parent_session_id` and `parent_turn_id` (on `subagent_stop`), `compaction`, `tool_name`, `tool_input`, `tool_result`. The environment always has `NAMZU_HOOK_EVENT` and `NAMZU_SESSION_ID`, has `NAMZU_TURN_ID` inside a turn, and `NAMZU_TOOL_NAME` and `NAMZU_TOOL_PATH` for a tool event.

Before `@namzu/sdk` 44 the turn id was called the run id in both places, and `subagent_stop` carried the parent's run id; the release notes list the old names.

The verdict is the exit code. `0` continues; on `user_prompt_submit` what the command printed becomes context for the model. `2` blocks on `pre_tool_use` (the call is skipped, the model told why) and on `user_prompt_submit` (the turn ends); on every other event it is logged and ignored. Any other exit, a timeout, or a command that could not start is logged and the turn goes on: a hook that could not answer has not answered no.

A `matcher` limits a tool hook to tool names: `*`, a name, or `a|b|prefix*`. On an event with no tool it matches only as `*`.

## In the CLI

The `hooks` key of `namzu.config.json` or `~/.namzu/config.yaml` is event → list of `{ command, matcher?, timeoutMs? }`. The session fires `session_start` before its first turn — once the conversation has its durable session id, which every later turn's hooks carry as `session_id`, so a hook can match them — and `session_end` when it closes, including on `/exit`, which now closes the session before the process leaves. `/hooks` lists what is attached.

## Request context inventory

`pre_llm_call.request.context` carries an immutable `snapshot` of content at
Namzu's **provider-input boundary**, after SDK compaction and rich-content
projection. `change` compares with the preceding `pre_llm_call` in the same
turn; it is absent on the first observation. A hook refusal still counts as an
observation of a prepared request, not proof that the provider received it.

Each part identifies its message/block position, role, kind, SHA-256 content
digest and, for tool calls/results, its call ID. Tool results distinguish error
from non-error status. Raw text and rich payloads are not copied into the
inventory. Tool-call arguments and result blocks are separate parts: retaining
a `read` call does not imply retaining the file content it returned. Repeated
identical blocks are counted as occurrences rather than collapsed into a set.
Message positions can shift without reporting unchanged content as removed.
The inventory does not report order changes as additions or removals.

`snapshotRequestContext(messages)` and `diffRequestContext(previous, next)` are
also exported by `@namzu/sdk`. Hosts can keep a snapshot across turns and compare
it themselves; the kernel's automatic baseline is turn-local. Snapshots retain
only metadata and hashes. There are no extra model calls, prompt instructions
or filesystem reads. Automatic hashing runs only when a plugin manager is
installed, alongside the existing model-call hook.

This inventory describes SDK input, not the provider's final internal context.
Adapter-private reasoning/replay state, server-side clearing, retries inside
providers and transport-level image recovery are not separately inventoried.
When calling the helper directly, pass the projected messages you intend to
inspect; it does not resolve stored attachments or perform compaction itself.
A stored reference identifies a reference, not its resolved bytes.

Exact-block presence does not establish comprehension, full-file coverage,
filesystem freshness or mutation permission. A shortened text block is reported
as replacement, not as a byte-range diff. No automatic suppression of `read`
is performed. Hooks can use this evidence to audit context policy without
mistaking retained transcript data for content in the prepared request.
