---
type: Reference
title: Hook events
description: The events the kernel fires for extensions and shell hooks, what each carries, which can answer with a verdict, the exit codes and JSON a shell hook answers with, and the limits on what a hook may decide.
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
| `turn_start` | at the start of a turn | `sessionId`, `turnId` | `error` fails the turn |
| `turn_end` | when the model has finished with nothing left to run, and again for every other way a turn ends | `sessionId`, `turnId`, `stopHookActive` | `error` fails the turn; `skip` keeps the turn going: its reason is given to the model as a message (kind `hook-feedback`) and the model works on |
| `turn_interrupt` | when a root session's turn is stopped by the user | `cancelCause` | nothing; every hook runs |
| `pre_tool_use` | before each tool call | `toolName`, `toolInput` | `skip`, `modify`, `error`; `continue` and `modify` may carry `permission` (see below) |
| `post_tool_use` | after each tool call | `toolName`, `toolInput`, `toolResult` | `replace`, `retry`, `error`; `continue` may carry `context` |
| `post_tool_use_failure` | after `post_tool_use`, for a call whose result is a failure | `toolName`, `toolInput`, `toolResult` | `error`; `continue` may carry `context` |
| `post_tool_batch` | once per model step, after every tool call of the step has settled and before the next model request (`post_tool_use` fires per call, and calls may run side by side); not fired for a step with no calls | `toolCalls`: each call's `toolCallId`, `toolName`, `toolInput`, `output` (what the model was given, a refusal or error included) and `isError` | `error` fails the turn; `continue` may carry `halt`, which ends the turn once the step is done |
| `permission_denied` | for each call refused without a person saying No: by a rule, the mode's policy, a classifier or a hook (a `pre_tool_use` or `permission_request` refusal reaches it too); never for a call a person declined | `toolName`, `toolInput`, `reason` | nothing |
| `turn_failure` | when a root session's turn fails (the model call or the turn itself); not for a cancellation, not for a child (its parent reads the failure as a tool result) | `error`: the failure's message | nothing; the turn has already failed |
| `permission_request` | when a person is about to be asked whether a call may run (never for a read nobody would be asked about) | `toolName`, `toolInput` | `skip` refuses the call; `continue` with `permission: { decision: 'allow' }` approves it |
| `notification` | when the host wants the operator's attention: a review is waiting (`approval_required`) or a turn settled (`turn_settled`) or the host has waited for the operator for a while (`idle_prompt`) | `notification: { type, message }` | nothing |
| `pre_llm_call`, `post_llm_call` | around each model call | `request`, `response` | `error` |
| `iteration_start`, `iteration_end` | around each iteration | `iteration` | `error` |
| `pre_compact`, `post_compact` | around a compaction pass once the check decided to run one | `compaction`: `reason` (`threshold` or `overflow`), `tokensBefore`, `tokensAfter` after, `contextWindowTokens` | `error` fails the turn; on `pre_compact`, `skip` cancels a pass the threshold asked for (a pass the provider forced, `overflow`, runs regardless) |
| `subagent_start` | once at the start of each child turn, before the child's `user_prompt_submit` | `parentSessionId`, `parentTurnId` (the parent turn whose tool call spawned it), `agentType` (the child's agent name) | `error` fails the child turn; `annotate` adds text to the child's context for its turn, as on `user_prompt_submit`; a root session never fires it |
| `subagent_stop` | after a child session's own `turn_end` | `parentSessionId`, `parentTurnId` (the parent turn whose tool call spawned it), `agentType`, `stopHookActive` | `error` fails the child turn's finalization; `skip` keeps the child working, as on `turn_end` |

All the hooks registered for an event start together, each on the context the event carried, and the kernel reads their answers in priority order (then registration order). None waits for another and none short-circuits, so a hook that refuses does not keep its siblings from running. The answers combine so that a refusal (`skip`) outranks `ask`, which outranks `allow`; of several rewrites (`modify`, `replace`) the last in order wins and no hook sees another's rewrite; every `context` is kept; every `halt` is honoured. Before `@namzu/sdk` 52 the hooks ran one by one (`post_*` in reverse), each seeing the previous hook's `modify`, and a refusal stopped the chain.

### What `continue`, `skip` and `modify` can carry

Beyond their action, the verdicts that let work go on take three optional fields:

- `context` is text for the model. On a tool event it is added after that call's result, framed as `[Hook note]` so the model reads it as a hook's words and not the tool's; it is bounded to 8 000 characters. On `user_prompt_submit` use `annotate`.
- `halt: { reason }` ends the turn once the current step's tool calls are answered, with stop reason `stop_condition` and `Stopped by a hook: <reason>` as the turn's last error. On `pre_tool_use` the call is withheld as well.
- `notice` is a warning for the operator, reported through the logger and shown in the terminal.

`permission` (`{ decision: 'allow' | 'ask', reason? }`, on `continue` and `modify` for `pre_tool_use`, and on `continue` for `permission_request`) answers whether a person must approve the call. A refusal is `skip`, and it always wins over every `allow` and `ask`; `ask` wins over `allow`.

- `ask` makes the call an explicit review: a call the tool declares read-only, or one a rule would allow, goes to a person anyway.
- `allow` stands in for the person's yes, and is audited as such, only on a call that would have been asked about for no reason beyond "it changes something". It never covers a sandbox escape, a path outside the roots, a call the tool declares it always needs approval for (`requiresApproval`), a call a rule sent to review explicitly, or a call the tool declares destructive; it never reopens what a rule or the dangerous-pattern floor denied; and `plan` and `strict` refuse a hook-allowed call as they refuse any other. A nested call (made by a tool through `dispatchTool`) cannot be reviewed, so a hook `ask` on one refuses it.
- A `modify` input goes through the same validation as an input the model supplied: the tool's schema runs again, a rewrite that fails it is a failed call and never reaches the tool, and the authorization gate and the review policy then see the rewritten call.

`ToolCallSummary.hookPermission` and `ToolCallSummary.hookGrant` carry the answer to a custom review handler; `approve_tools` may list `hookGranted` ids, which the kernel writes to the audit trail and ignores for any call that did not carry the mark.

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

A shell hook is one command per event (or an HTTP request or a model question, see below), run with `sh -c` in the working directory, with the event as JSON on stdin and a deadline (ten minutes by default, which is also the most). It may attach to `user_prompt_submit`, `session_start`, `session_end`, `pre_tool_use`, `post_tool_use`, `post_tool_use_failure`, `post_tool_batch`, `permission_request`, `permission_denied`, `notification`, `pre_compact`, `post_compact`, `subagent_stop`, `subagent_start`, `turn_start`, `turn_end` and `turn_failure`. The model-call and iteration events stay in-process: they carry the messages, and a shell is not where those go.

The stdin JSON always has `event`, `hook_event_name` (the same event in PascalCase: `PreToolUse`, `PostToolUse`, `Stop`, `UserPromptSubmit` and the rest; events with no PascalCase spelling repeat `event`), `cwd` and `session_id`; `transcript_path` (the session's transcript file) and `permission_mode` (`default`, `acceptEdits`, `plan`, `auto` or `bypassPermissions`; the terminal reports its modes as `prompt` and anything unlisted as `default`, `accept-edits` as `acceptEdits`, `plan` as `plan`, `classify` as `auto`, and both `bypass` and an unattended run as `bypassPermissions`, so a script that relaxes its checks under that word is told a run that is not asking; before the first turn a session that asks reports `default`) when the host knows them, as the terminal does; `turn_id` on every event inside a turn (never on `session_start` or `session_end`); and when the event has them `prompt`, `parent_session_id`, `parent_turn_id`, `agent_id` (the child's session id) and `agent_type` (on `subagent_start` and `subagent_stop`), `compaction`, `tool_name`, `tool_input`, `tool_result` (also sent as `tool_response`, the same object), `tool_calls` (on `post_tool_batch`: a list of `tool_name`, `tool_input`, `tool_use_id`, `tool_response`, the text the model was given, and `is_error`), `reason` (on `permission_denied`), `error` (on `post_tool_use_failure` and `turn_failure`), `notification_type` and `message` (on `notification`), and `stop_hook_active: true` (on `turn_end` and `subagent_stop` when an earlier answer already kept the turn going). A script written for another host's hook format reads its names unchanged; the Namzu names stay, so no existing script changes. A host embedding the kernel supplies the two session facts with `transcriptPath` and `permissionMode` on the options of `attachShellHooks`; each is called at every run. The environment always has `NAMZU_HOOK_EVENT` and `NAMZU_SESSION_ID`, has `NAMZU_TURN_ID` inside a turn, and `NAMZU_TOOL_NAME` and `NAMZU_TOOL_PATH` for a tool event.

Before `@namzu/sdk` 44 the turn id was called the run id in both places, and `subagent_stop` carried the parent's run id; the release notes list the old names.

### The exit code

`0` continues; on `user_prompt_submit` and `subagent_start` plain (non-JSON) stdout becomes context for the model. `2` is read per event:

| Event | Exit 2 |
| --- | --- |
| `pre_tool_use` | the call is skipped and the model is told why, with stderr as the reason |
| `user_prompt_submit` | the turn ends, naming the reason |
| `subagent_start` | the child still starts; stderr is given to it as context |
| `turn_end`, `subagent_stop` | stderr is given to the model and the turn goes on |
| `pre_compact` | a compaction the threshold asked for is cancelled |
| `post_tool_use`, `post_tool_use_failure` | stderr is shown to the model beside that call's result |
| every other event | logged and ignored |

Any other exit, a timeout, or a command that could not start is logged and the turn goes on: a hook that could not answer has not answered no. JSON on stdout is read only on exit `0`.

### The JSON answer

On exit `0`, stdout that starts with `{` is the hook's JSON answer. Output that does not start with `{` is plain text. Output that starts with `{` but is not valid JSON, or has a field of the wrong type, or names another event, is reported (`hook output ignored`) and set aside whole: nothing in it is half-obeyed.

| Field | Meaning |
| --- | --- |
| `continue: false`, `stopReason` | stop the turn after the current step (`halt`); before a tool the call is withheld too; on a prompt the turn ends; on `turn_end` it wins over any request to keep going |
| `decision: "block"`, `reason` | refuse: a tool call, a prompt, a compaction (`pre_compact`); on `turn_end` and `subagent_stop` keep the turn going with `reason` as the model's feedback; after a tool ran, `reason` is what the model is told about the result |
| `decision: "approve"` | `allow` for a tool call or a permission request |
| `systemMessage` | a warning for the operator |
| `suppressOutput: true` | keep this hook's stdout out of the debug log |
| `hookSpecificOutput` | `hookEventName` is required and must name this event, either as Namzu spells it (`pre_tool_use`) or in the PascalCase spelling (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `PermissionRequest`, `Notification`, `PreCompact`, `SessionStart`) |

`hookSpecificOutput` carries, for `pre_tool_use`: `permissionDecision` (`allow`, `deny`, `ask`; `defer` decides nothing), `permissionDecisionReason`, `updatedInput` (an object that replaces the call's input) and `additionalContext`; for `permission_request`: `decision` as `{ "behavior": "allow" }` or `{ "behavior": "deny", "message": "...", "interrupt": true }`; and `additionalContext` for `user_prompt_submit` and `subagent_start` (context for the turn), `post_tool_use`, `post_tool_use_failure` (shown beside the result), `turn_end` and `subagent_stop` (feedback; the turn goes on), `session_start` and `notification` (accepted, not delivered).

### Options on an entry

- `matcher` limits a hook to a name: the tool on a tool event and on `permission_request`, the notification type on `notification`, the agent name on `subagent_start` and `subagent_stop`. `*` or empty matches all; a list of names separated by `|` or `,` (each optionally ending in `*` as a prefix) matches those; anything else is a regular expression, tested unanchored against the name, and one that does not compile matches nothing. On an event with no name it matches only as `*`.
- `if` is a permission-rule filter on a tool event, checked before the process is spawned: `bash(git push *)`, `Bash`, `Edit`. The tool part is case-insensitive and takes the names skills write. A pattern applies to a shell tool's command, one command at a time, so `Bash(git push *)` still fires for `cd x && git push`; a line that cannot be read (`eval`) and a filter that means nothing for the tool run the hook, so a guard is never switched off by a typo.
- `once: true` runs the hook one time per session.
- `statusMessage` is shown on the terminal's status line while the hook runs.
- `onFailure` is `continue` (the default) or `block`. A hook fails when it could not start, timed out, exited with a code other than `0` or `2`, or printed JSON that does not read. `continue` logs it and lets the action go ahead; `block` counts the failure as exit `2`, so the action the event guards is refused with the failure as the reason. It is not read on a `prompt` hook or an `async` command.
- `timeoutMs` is the deadline (ten minutes by default and at most; before `@namzu/sdk` 52 the default was 30 s, so set `timeoutMs: 30000` to keep it). The lifecycle manager's own per-hook limit (`hookTimeoutMs`) defaults to the same ten minutes.

Entries of one event run in parallel; see above for how their answers combine.

### Other kinds of hook

An entry is a command unless it says `type`. All the options above apply to every kind.

- **Exec form** (`command` with `args`). `command` is the program and `args` its arguments, spawned directly with no shell, so a path with a space, a quote or a `$` is passed exactly as written. `args: []` runs the program with no arguments.
- **`async: true`** on a command. The command is started and the turn carries on; its exit code and output decide nothing and a failure is only logged. It is not killed when the turn ends, only by its deadline. A hook that should be able to refuse is not async.
- **`type: http`** with `url`. The event JSON is posted to `url` (`http` or `https`) and a 2xx body is read as the hook's answer exactly as a command's stdout is; any other status, a network error and the deadline are the hook failing. `headers` are added to the request, and a value may use `$NAME` or `${NAME}` for an environment variable listed in `allowedEnvVars`; any other reference becomes empty, and line breaks in a value are dropped. A name that resolves to a private or link-local address is refused where the connection is made (loopback is allowed, for a local service), and redirects are not followed.
- **`type: prompt`** with `prompt`. The small model is asked whether a condition holds. `$ARGUMENTS` in the text is replaced by the event JSON (the event follows the text when there is no placeholder), and the model answers `{"ok": true}` or `{"ok": false, "reason": "..."}`. `false` refuses as exit `2` does, with the reason. No small model, an error, the deadline (30 seconds by default) or an answer that does not read lets the action go ahead. The question is put on the model the host supplies as `judge` in the options of `attachShellHooks`; without one a prompt hook does nothing.

### Where shell hooks differ from the common hook contract

The JSON answer, the exit codes and the options above follow the JSON hook contract. These differences are deliberate:

- **A hook's `allow` is narrower.** It never covers a sandbox escape, a path outside the roots, a call the tool always asks about, an explicit review rule's call or a destructive call, and it never reopens a deny. A hook `deny` always wins.
- **A rewrite is checked twice.** `updatedInput` is validated like a model-supplied input and then authorized as the rewritten call, so a rewrite can neither slip past a rule nor reach a tool whose schema refuses it.
- **`permission_request` fires for every call that would have gone to the review policy,** whatever the mode: in `auto` nobody is asked, and a `permission_request` hook still runs and its `skip` still refuses. It fires whether or not a dialog is shown. `notification` is fired by the terminal application only, not by `namzu exec`.
- **One compaction is out of reach.** `pre_compact` can cancel a pass the threshold asked for and not one the provider forced.
- **The order of answers is deterministic.** Answers are read in priority and registration order, so which refusal is quoted and which rewrite wins never depends on timing.
- **Three events observe and decide little.** `permission_denied` and `turn_failure` take no verdict; `post_tool_batch` takes `continue: false` (and `error` from an in-process hook) and ignores `additionalContext`. `turn_failure` is spelled `StopFailure` in `hook_event_name`; a `matcher` on `permission_denied` names the tool, and on the other two it matches only as `*`. `subagent_start` is not observational: its `additionalContext` reaches the child before the prompt, and an in-process hook's `error` fails the child turn.
- **`post_tool_use_failure` is in addition to `post_tool_use`,** which keeps firing for a failed call as it always did; a failed call fires both events.
- **Not delivered:** a `pre_compact` hook's stdout as custom compaction instructions, `additionalContext` from `session_start`, `updatedInput` from a `permission_request` allow, `permissionDecision: "defer"` (it decides nothing), `updatedToolOutput`, `sessionTitle` and the other fields that have no counterpart here. `agent` and `mcp_tool` hook types do not exist here, and a command's `asyncRewake` (waking the model when a background hook exits `2`) is not offered.
- **`matcher` keeps its glob.** A name ending in `*` is a prefix, as it has been; a regular expression would read the same text differently.

## In the CLI

The `hooks` key of `namzu.config.json` or `~/.namzu/config.yaml` is event → list of hooks: `{ command, args?, async?, matcher?, timeoutMs?, if?, once?, statusMessage?, onFailure? }`, `{ type: http, url, headers?, allowedEnvVars?, … }` or `{ type: prompt, prompt, … }`. In the terminal a `prompt` hook uses the small model and its tokens count against the turn it fired in; it is not asked outside a turn (`session_start`, `session_end`). The session fires `session_start` before its first turn — once the conversation has its durable session id, which every later turn's hooks carry as `session_id`, so a hook can match them — and `session_end` when it closes, including on `/exit`, which now closes the session before the process leaves. `/hooks` lists what is attached. A hook's `statusMessage` shows on the status line while it runs, a hook that stops the turn or warns the operator leaves a line in the transcript, and `notification` hooks hear about every review that waits and every turn that settles, whether or not a terminal notification is configured.

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
