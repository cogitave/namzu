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
| `session_start`, `session_end` | by the host: before the session's first turn, and when it closes | `sessionId`; `runId` is minted for the session's own hooks, not a turn | nothing |
| `user_prompt_submit` | by the kernel, before the model sees the prompt and before `run_start` | `prompt`, `sessionId` | `skip` blocks the run, which ends failed and names the reason; `annotate` adds text to the system prompt for the whole run |
| `run_start`, `run_end` | at the edges of a run | `runId` | `error` fails the run |
| `run_interrupt` | when a root run is stopped by the user | `cancelCause` | nothing; every hook runs |
| `pre_tool_use`, `post_tool_use` | around each tool call | `toolName`, `toolInput`, `toolResult` | `skip`, `modify`, `error`; `replace`, `retry` after |
| `pre_llm_call`, `post_llm_call` | around each model call | `request`, `response` | `error` |
| `iteration_start`, `iteration_end` | around each iteration | `iteration` | `error` |
| `pre_compact`, `post_compact` | around a compaction pass once the check decided to run one | `compaction`: `reason` (`threshold` or `overflow`), `tokensBefore`, `tokensAfter` after, `contextWindowTokens` | nothing; a context the provider will reject is not a hook's to insist on |
| `subagent_stop` | after a delegated run's own `run_end` | `parentRunId` | nothing |

`post_*` hooks run in reverse registration order, so a formatter registered last runs first after a write.

## Shell hooks

A shell hook is one command per event, run with `sh -c` in the working directory, with the event as JSON on stdin and a deadline (30 s by default, ten minutes at most). It may attach to `user_prompt_submit`, `session_start`, `session_end`, `pre_tool_use`, `post_tool_use`, `pre_compact`, `post_compact`, `subagent_stop`, `run_start` and `run_end`. The model-call and iteration events stay in-process: they carry the messages, and a shell is not where those go.

The stdin JSON has `event`, `cwd`, `run_id`, and when the event has them `session_id`, `prompt`, `parent_run_id`, `compaction`, `tool_name`, `tool_input`, `tool_result`. The environment has `NAMZU_HOOK_EVENT`, `NAMZU_RUN_ID`, `NAMZU_SESSION_ID`, `NAMZU_TOOL_NAME` and `NAMZU_TOOL_PATH`.

The verdict is the exit code. `0` continues; on `user_prompt_submit` what the command printed becomes context for the model. `2` blocks on `pre_tool_use` (the call is skipped, the model told why) and on `user_prompt_submit` (the run ends); on every other event it is logged and ignored. Any other exit, a timeout, or a command that could not start is logged and the run goes on: a hook that could not answer has not answered no.

A `matcher` limits a tool hook to tool names: `*`, a name, or `a|b|prefix*`. On an event with no tool it matches only as `*`.

## In the CLI

The `hooks` key of `namzu.config.json` or `~/.namzu/config.yaml` is event → list of `{ command, matcher?, timeoutMs? }`. The session fires `session_start` before its first turn — once the conversation has the durable id a run will carry, so a hook can match the two — and `session_end` when it closes, including on `/exit`, which now closes the session before the process leaves. `/hooks` lists what is attached.
