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
| `session_start`, `session_end` | by the host: before the session's first turn, and when it closes | `sessionId`, and no `turnId`: these belong to the session, not to a turn; `source` on `session_start` and `endReason` on `session_end` (see [Session start and end](#session-start-and-end)) | `session_start`: `continue` with `context`, or `annotate`, is text for the model for the whole session; `session_end`: nothing |
| `user_prompt_submit` | by the kernel, before the model sees the prompt and before `turn_start` | `prompt`, `sessionId`, `turnId` | `skip` blocks the turn, which ends failed and names the reason; `annotate` adds text to the system prompt for the whole turn |
| `turn_start` | at the start of a turn | `sessionId`, `turnId` | `error` fails the turn |
| `turn_end` | when the model has finished with nothing left to run, and again for every other way a turn ends | `sessionId`, `turnId`, `stopHookActive`, `lastAssistantMessage` (see [The last message](#the-last-message)) | `error` fails the turn; `skip` keeps the turn going: its reason is given to the model as a message (kind `hook-feedback`) and the model works on |
| `turn_interrupt` | when a root session's turn is stopped by the user | `cancelCause` | nothing; every hook runs |
| `pre_tool_use` | before each tool call | `toolName`, `toolCallId`, `toolInput` | `skip`, `modify`, `error`; `continue` and `modify` may carry `permission` (see below) |
| `post_tool_use` | after each tool call | `toolName`, `toolCallId`, `toolInput`, `toolResult` | `replace`, `retry`, `error`; `continue` may carry `context` |
| `post_tool_use_failure` | after `post_tool_use`, for a call whose result is a failure | `toolName`, `toolCallId`, `toolInput`, `toolResult` | `error`; `continue` may carry `context` |
| `post_tool_batch` | once per model step, after every tool call of the step has settled and before the next model request (`post_tool_use` fires per call, and calls may run side by side); not fired for a step with no calls | `toolCalls`: each call's `toolCallId`, `toolName`, `toolInput`, `output` (what the model was given, a refusal or error included) and `isError` | `error` fails the turn; `continue` may carry `halt`, which ends the turn once the step is done |
| `permission_denied` | for each call refused without a person saying No: by a rule, the mode's policy, a classifier or a hook (a `pre_tool_use` or `permission_request` refusal reaches it too); never for a call a person declined | `toolName`, `toolCallId`, `toolInput`, `reason` | nothing |
| `turn_failure` | when a root session's turn fails (the model call or the turn itself); not for a cancellation, not for a child (its parent reads the failure as a tool result) | `error`: the failure's message | nothing; the turn has already failed |
| `permission_request` | when a person is about to be asked whether a call may run (never for a read nobody would be asked about) | `toolName`, `toolCallId`, `toolInput` | `skip` refuses the call; `continue` with `permission: { decision: 'allow' }` approves it |
| `notification` | when the host wants the operator's attention: a review is waiting (`approval_required`) or a turn settled (`turn_settled`) or the host has waited for the operator for a while (`idle_prompt`) | `notification: { type, message }` | nothing |
| `pre_llm_call`, `post_llm_call` | around each model call | `request`, `response` | `error` |
| `iteration_start`, `iteration_end` | around each iteration | `iteration` | `error` |
| `pre_compact`, `post_compact` | around every compaction pass once the check decided to run one: the kernel's own (threshold, provider overflow), an idle pass, and one a person asked for (`/compact`, summarising a span); see [Compaction hooks](#compaction-hooks) | `compaction`: `reason` (`threshold`, `overflow`, or `manual` for a pass a host asked for outside a turn), `trigger` (`manual` or `auto`), `tokensBefore`, `tokensAfter` after, `contextWindowTokens`; `instructions` on `pre_compact` (what the person typed, or `null`); `summary` on `post_compact` | `error` fails the turn; on `pre_compact`, `skip` cancels a pass the threshold asked for and refuses one a person asked for (a pass the provider forced, `overflow`, runs regardless); on `pre_compact`, `annotate` (or `continue` with `context`) tells the summariser what to keep |
| `subagent_start` | once at the start of each child turn, before the child's `user_prompt_submit` | `parentSessionId`, `parentTurnId` (the parent turn whose tool call spawned it), `agentType` (the child's agent name: `reviewer` for an agent file called `reviewer`; a host that runs agents through `QueryAgent` names them with `QueryAgentConfig.agentType`, and without it `agentType` is the agent class's `type`) | `error` fails the child turn; `annotate` adds text to the child's context for its turn, as on `user_prompt_submit`; a root session never fires it |
| `subagent_stop` | after a child session's own `turn_end` | `parentSessionId`, `parentTurnId` (the parent turn whose tool call spawned it), `agentType`, `stopHookActive`, `lastAssistantMessage` | `error` fails the child turn's finalization; `skip` keeps the child working, as on `turn_end` |

All the hooks registered for an event start together, each on the context the event carried, and the kernel reads their answers in priority order (then registration order). None waits for another and none short-circuits, so a hook that refuses does not keep its siblings from running. The answers combine so that a refusal (`skip`) outranks `ask`, which outranks `allow`; of several rewrites (`modify`, `replace`) the last in order wins and no hook sees another's rewrite; every `context` is kept; every `halt` is honoured. Before `@namzu/sdk` 52 the hooks ran one by one (`post_*` in reverse), each seeing the previous hook's `modify`, and a refusal stopped the chain.

### A hook that keeps refusing to let a turn end

A `skip` from `turn_end` or `subagent_stop` keeps the turn going, and the model gets the reason as a `hook-feedback` message. A hook that answers `skip` every time would keep the turn going until `maxIterations` ended it (a turn with no iteration limit would never end), so the kernel counts the refusals. Refusals are counted in a row: a round in which `turn_end` and `subagent_stop` both refuse is one refusal, and a tool call between refusals starts the count over.

Once `TurnConfig.maxHookRefusals` refusals have been honoured (no limit when unset or `0`: the SDK sets none, so a host that does not opt in sees no change) the next one is not: the turn ends the way it would have with no hook, and one `hook-feedback` message is recorded in the transcript naming the hook ("`closing-gate` asked for more before this turn could end 8 times in a row. Namzu is ending the turn anyway..."). The hook is still asked, and a `halt` it asks for is still honoured. A hook that refuses fewer times than the limit sees no change. The count is per turn and is not carried to the next one. The CLI sets 8 by default through `limits.maxHookRefusals` ([Turn limits](../cli/turn-limits.md#hook-refusals)).

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
`session_end` and `turn_interrupt` only accept `continue` as a declared verdict
and `session_start` accepts `continue` and `annotate`: none of their returned
values can decide a turn. The runtime still checks JavaScript hook results
independently; unsupported actions are rejected by query hooks, while
`session_end` and `turn_interrupt` ignore their results.

Every hook context carries `sessionId`. `turnId` is present on every event
inside a turn and absent on `session_start` and `session_end`
(`PluginHookContext.turnId?`).

The events were named `run_start`, `run_end` and `run_interrupt` before
`@namzu/sdk` 44. A configuration or plugin that registers an old name is
refused when it is loaded, with a message naming the new one
(`RENAMED_PLUGIN_HOOK_EVENTS`, `assertPluginHookEvent`).

### Session start and end

A session is one conversation to the hooks. `session_start` fires when a conversation begins (at its first turn, so the context it supplies can go into that turn's request) and `session_end` when it ends. A hook may give the model context for the whole conversation: plain stdout on exit `0`, `hookSpecificOutput.additionalContext` in a shell hook's JSON answer, or `continue` with `context` (or `annotate`) from an in-process hook. Every answer is joined in answer order, bounded to 8 000 characters (`[truncated]` marks a cut), and framed as the operator's hooks speaking (`Context from the operator's hooks:`), the same frame `user_prompt_submit` context carries. `sessionStartHookContext(results)` is the function that reads the answers; a host that embeds the kernel calls it on the results of `executeHooks('session_start', ...)` and gives the text to its turns.

- **Fixed for the conversation.** The text is read once, from the hooks' first answer, and is the same on every turn of that conversation, so the provider's prompt cache keeps working. The CLI delivers it with each request, after the conversation, and never writes it into the conversation, so it survives compaction. A compaction is not a session event: it fires `pre_compact` and `post_compact`, never `session_start`.
- **Another conversation gets its own text.** When the person clears the conversation, resumes another or forks, the old conversation's text is dropped at once and the new conversation's own `session_start` hooks supply what it carries; if they print nothing, it carries nothing. The earlier text is never carried into the next conversation, and never twice.
- **`source`** on `session_start`: `startup` for a conversation with no earlier turn, `resume` for one that has turns (a resume, a `--continue`, a fork, a session rebuilt under a running terminal after a model change) and `clear` for the empty conversation that follows `/clear` or `/new`. `matcher` on `session_start` is tested against it: `startup`, `resume`, `clear`, `startup|resume`. A hook that must not repeat its work on resume says so with `matcher: "startup"`; one that wants only a cleared conversation says `matcher: "clear"`.
- **`endReason`** on `session_end`: `exit` (the host is finishing: the process ends, the person quits), `replaced` (the host moves to another session or conversation in its place: a model or account switch, another conversation opened, a fork or a rewind) or `clear` (the person cleared it with `/clear` or `/new`). `matcher` on `session_end` is tested against it. Shell hooks read the two as `source` and `reason` on stdin; both carry the id of the conversation they speak of as `session_id`.
- **The end hook of a conversation left behind** runs at once and has the same deadline as on exit: five seconds in the CLI when the entry names none, its own `timeoutMs` otherwise. It never holds the new conversation back, which starts without waiting for it; the program leaving waits for it, for no longer than its deadline.
- A `prompt` hook is still not asked outside a turn.

#### Every way a conversation begins and ends

`session_start` is told at the first turn of the conversation that began, so a conversation that is opened and left unused tells its end hook and never a start hook.

| What happens | `session_end` | `session_start` |
| --- | --- | --- |
| The terminal or `namzu exec` opens on a new conversation | | `startup` |
| It opens on a conversation that has turns (`--continue`, or a conversation resumed at launch) | | `resume` |
| `/clear` or `/new` | old id, reason `clear` | new id, source `clear` |
| `/resume` picks another conversation | old id, reason `replaced` | the picked id, `resume` (`startup` if it has no turn) |
| `/fork`, or branching from an earlier prompt with `/rewind` | old id, reason `replaced` | the copy's id, `resume` (`startup` if it holds no turn) |
| A model, provider or account switch builds another session | the old session's conversation, reason `replaced` | the same conversation, `resume` if it has turns |
| The person quits, or the process ends | the current id, reason `exit` | |
| A compaction, `/compact` or the idle pass | | |
| A sub-agent starts or finishes | | |
| `/add-dir`, `/worktree` (prints a command for another terminal) | | |

The conversation a `/clear`, a resume or a fork leaves is told once, by the end hook, and the old context is dropped before the new conversation's first turn. A Pal's conversation runs with no hooks today, so none of the rows fire for it; the clear reason is passed when its session is closed, ready for the day it has them.

## Shell hooks

A shell hook is one command per event (or an HTTP request or a model question, see below), run with `sh -c` in the working directory, with the event as JSON on stdin and a deadline (ten minutes by default, which is also the most; the command line gives `session_end` hooks five seconds when they name none, see [In the CLI](#in-the-cli)). It may attach to `user_prompt_submit`, `session_start`, `session_end`, `pre_tool_use`, `post_tool_use`, `post_tool_use_failure`, `post_tool_batch`, `permission_request`, `permission_denied`, `notification`, `pre_compact`, `post_compact`, `subagent_stop`, `subagent_start`, `turn_start`, `turn_end` and `turn_failure`. The model-call and iteration events stay in-process: they carry the messages, and a shell is not where those go.

The stdin JSON always has `event`, `hook_event_name` (the same event in PascalCase: `PreToolUse`, `PostToolUse`, `Stop`, `UserPromptSubmit` and the rest; events with no PascalCase spelling repeat `event`), `cwd` and `session_id`; `transcript_path` (the session's transcript file) and `permission_mode` (`default`, `acceptEdits`, `plan`, `auto` or `bypassPermissions`; the terminal reports its modes as `prompt` and anything unlisted as `default`, `accept-edits` as `acceptEdits`, `plan` as `plan`, `classify` as `auto`, and both `bypass` and an unattended run as `bypassPermissions`, so a script that relaxes its checks under that word is told a run that is not asking; before the first turn a session that asks reports `default`) when the host knows them, as the terminal does; `turn_id` on every event inside a turn (never on `session_start` or `session_end`); and when the event has them `prompt`, `parent_session_id`, `parent_turn_id`, `agent_id` (the child's session id) and `agent_type` (on `subagent_start` and `subagent_stop`), `compaction` (with `trigger`), `trigger`, `custom_instructions` (on `pre_compact`: what the person typed with the command, `null` when nothing), `compact_summary` (on `post_compact`), `tool_name`, `tool_use_id` (the call's id, on the five single-call tool events: see [the values a moved script must expect](#where-shell-hooks-differ-from-the-common-hook-contract)), `tool_input`, `tool_result` (also sent as `tool_response`, the same object), `tool_calls` (on `post_tool_batch`: a list of `tool_name`, `tool_input`, `tool_use_id`, `tool_response`, the text the model was given, and `is_error`), `source` (on `session_start`: `startup`, `resume` or `clear`), `reason` (on `permission_denied`: why the call was refused; on `session_end`: `exit`, `replaced` or `clear`), `error` (on `post_tool_use_failure` and `turn_failure`), `notification_type` and `message` (on `notification`), `last_assistant_message` (on `turn_end` and `subagent_stop`, when the turn produced text), and `stop_hook_active: true` (on `turn_end` and `subagent_stop` when an earlier answer already kept the turn going). A script written for another host's hook format finds the same field names, the PascalCase `hook_event_name`, the same exit codes and the same fields in the JSON answer. The values in those fields are Namzu's own, and a script that compares them must be moved with care: see [the values a moved script must expect](#where-shell-hooks-differ-from-the-common-hook-contract). The Namzu names stay, so no existing script changes. A host embedding the kernel supplies the two session facts with `transcriptPath` and `permissionMode` on the options of `attachShellHooks`; each is called at every run. The environment always has `NAMZU_STARTED_BY_SESSION=1` (a program that must not be run by a session, such as `namzu send`, refuses when it sees it), `NAMZU_HOOK_EVENT`, `NAMZU_SESSION_ID` and `NAMZU_PROJECT_DIR`, has `NAMZU_TURN_ID` inside a turn, and `NAMZU_TOOL_NAME` and `NAMZU_TOOL_PATH` for a tool event (`NAMZU_TOOL_PATH` is the call's `path`, or `file_path` or `filePath` when the input has no `path`, and is not set when the input names no file).

- `NAMZU_PROJECT_DIR` is the folder the session was started for (the working directory it was opened on), so a script can find its own files (`"$NAMZU_PROJECT_DIR/.hooks/check.sh"`) whatever directory it has changed to. A host that embeds the kernel passes it as `projectDir` in the options of `attachShellHooks`; without it the variable is `cwd`.
- **Variables a moved command expects.** A command written for another tool often starts with a variable for the project folder named for that tool (`"$SOMETOOL_PROJECT_DIR/.hooks/check.sh"`). When an entry's `command` or `args` refer to a variable written `$NAME` or `${NAME}` that is not set in the environment the hook is started with, and whose name ends in `_PROJECT_DIR`, the hook is started with that variable set to the project folder (the value of `NAMZU_PROJECT_DIR`). The rule reads the shape of the name, not a list of tools. A name that is already set, even to an empty string, is never overwritten; `${NAME:-default}` and the other forms with a default are read the same way. The name is looked for in the entry's own `command` and `args` text, and nowhere else: a script that reads such a variable inside its own file cannot be seen from here, and needs the entry's `env` key (see [Options on an entry](#options-on-an-entry)). An entry that refers to no such variable starts with exactly the environment it always had.
- The rest of the launching environment is inherited as it was. That is why a hook may also see `NAMZU_PROVIDER` and `NAMZU_MODEL` (the person's own settings for the launch, when they set them) and `NAMZU_SHELL_TAG`: the last is a tag the kernel adds to a shell it starts so it can end everything that shell started. It is internal, and a script must not read, set or depend on it.

Before `@namzu/sdk` 44 the turn id was called the run id in both places, and `subagent_stop` carried the parent's run id; the release notes list the old names.

### The exit code

`0` continues; on `user_prompt_submit`, `subagent_start` and `session_start` plain (non-JSON) stdout becomes context for the model. `2` is read per event:

| Event | Exit 2 |
| --- | --- |
| `pre_tool_use` | the call is skipped and the model is told why, with stderr as the reason |
| `user_prompt_submit` | the turn ends, naming the reason |
| `subagent_start` | the child still starts; stderr is given to it as context |
| `turn_end`, `subagent_stop` | stderr is given to the model and the turn goes on |
| `pre_compact` | a compaction the threshold asked for is cancelled, and one a person asked for is refused with the reason shown to them in one line |
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

`hookSpecificOutput` carries, for `pre_tool_use`: `permissionDecision` (`allow`, `deny`, `ask`; `defer` decides nothing), `permissionDecisionReason`, `updatedInput` (an object that replaces the call's input) and `additionalContext`; for `permission_request`: `decision` as `{ "behavior": "allow" }` or `{ "behavior": "deny", "message": "...", "interrupt": true }`; and `additionalContext` for `user_prompt_submit` and `subagent_start` (context for the turn), `session_start` (context for the whole session), `post_tool_use`, `post_tool_use_failure` (shown beside the result), `turn_end` and `subagent_stop` (feedback; the turn goes on), `pre_compact` (what the summary should keep) and `notification` (accepted, not delivered); and, for `post_tool_use` and `post_tool_use_failure`, `updatedToolOutput`: the replacement for the result the model reads, of any JSON type (see below); for a tool-server tool also `updatedMCPToolOutput`.

`updatedToolOutput` is for redaction. The call stands (it is not reported as failed, and a call that did fail stays failed); the model is shown the hook's text instead of the tool's, cut to 32 000 characters (`[truncated]` marks a cut). **Any JSON type is a replacement.** A string is the text. An object that has the shape of the result object a hook is sent (`output` a string, and `success` a boolean and `error` a string when present) is read as that result: its `output` is the text, and when `success` is `false` with an `error`, the error follows the output as `Error: ...` the way a failed tool's does; the call's own success is not changed by it. Any other object, an array, a number or a boolean is shown as its JSON text (`{"a":1}`, `[1,2]`, `42`, `true`). `null` is no replacement, as if the field were absent; an empty string is a replacement. **For a tool-server tool** (`mcp__<server>__<tool>`) the common contract's second field, `updatedMCPToolOutput`, is read the same way. When both fields carry a value, `updatedToolOutput` wins: it is the field for every tool, so a script that sets it has said the general thing; a `null` there lets `updatedMCPToolOutput` through. On any other tool `updatedMCPToolOutput` is not read. A hook's whole answer is read only up to 64 KiB (65 536 characters) of stdout: past that the answer is reported as too large (with the limit) and set aside, so a redaction hook must keep its answer under that size. **A hook used for redaction should set `onFailure: block`.** A hook that fails (it could not start, timed out, exited with a code other than `0` or `2`, or printed an answer that does not read, one over the limit included) has not redacted anything, so with `onFailure: continue` (the default) the failure is logged and the tool's original, unredacted result is shown. With `onFailure: block`, on `post_tool_use` and `post_tool_use_failure`, the result is withheld instead: the model reads one line in its place saying that a hook guarding this result failed and the result is therefore not shown, with the failure's short reason (a parser's own detail is left out, as it can quote the answer), and the record carries the same `[Hook note]` as for any replaced result, so the line is never mistaken for the tool's own words. The tool call has already run; withholding its result does not undo it. An in-process hook is not changed by this. Rich blocks the tool returned (an image) survive. Beside the text, in what the model reads and in the recorded result alike, goes `[Hook note]` with `A hook replaced this tool result: the text above is the hook's, not the tool's own output.`, so the record is never mistaken for the tool's own words; an `additionalContext` in the same answer joins that note. Each hook of the event answers on the original result, and of several replacements the last in order wins. The field is read on `post_tool_use` and on `post_tool_use_failure`, so a hook attached only to the failure event can redact a failed call's output as well; a call that failed fires both, and of several replacements the last in order wins. An in-process hook gets the same with `replace` and `disclose: true`; without `disclose` an in-process replacement stays unmarked, as it has always been.

**When a replacement is asked for and the original is shown.** No answer that carries a replacement is unreadable because of the replacement's type. These are every remaining way the original reaches the model, and what covers each:

| What happens | Original shown with `onFailure: continue` (default) | With `onFailure: block` |
| --- | --- | --- |
| The hook could not start, timed out, or exited with a code other than `0` or `2` | yes | withheld: the model reads the one line saying a guard failed |
| The answer is not valid JSON, or is over 64 KiB of stdout | yes | withheld |
| The hook tried to replace and put the answer where it is not read: `updatedToolOutput` (or `updatedMCPToolOutput`) at the top level instead of under `hookSpecificOutput`, a log line before the JSON on stdout, or the JSON on stderr (on `post_tool_use` and `post_tool_use_failure`, any stdout that does not start with `{` or stderr that names one of those two keys) | yes: the failure is logged | withheld |
| Another field of the same answer has the wrong type (`decision: "maybe"`, `additionalContext: 5`), or `hookEventName` names another event | yes: the whole answer is set aside | withheld |
| The hook exited `2` | yes, with its stderr beside the result; exit `2` reads no JSON | not a failure: the same |
| The entry is `async: true` | yes: an async hook decides nothing, and a warning is logged when its answer carried an action | not read: `onFailure` is not read on an `async` command |
| The entry is a `prompt` hook | yes: a prompt hook answers allow or refuse, never a replacement | not read on a prompt hook |
| The replacement is on another event (`post_tool_batch`, `pre_tool_use`, ...) | yes: not read there | not read |
| `updatedMCPToolOutput` on a tool that is not a tool-server tool | yes: not read | not read |
| The replacement is longer than 32 000 characters | no: it is cut and marked `[truncated]`, never swapped for the original | the same |

`onFailure: block` covers every row where the hook answered, failed or was not understood. It cannot cover the rows where the entry is not allowed to decide (`async`, `prompt`) or where the event cannot take a replacement: put a redaction on a `post_tool_use` command entry, not `async`.

### Options on an entry

- `matcher` limits a hook to a name: the tool on a tool event and on `permission_request`, the notification type on `notification`, the agent name on `subagent_start` and `subagent_stop`, `source` on `session_start`, `reason` on `session_end` and `trigger` (`manual` or `auto`) on `pre_compact` and `post_compact`. `*` or empty matches all; **on an event with no name** (`user_prompt_submit`, `turn_start`, `turn_end`, `turn_failure`, `post_tool_batch`) **the matcher is ignored and the hook always fires**, as in the common hook contract, so a moved `Stop` or `UserPromptSubmit` group with a matcher still runs. Anything else is read as a list of names, as a pattern, or as both, and **the hook fires if either reading matches**:
  - **A list** of names separated by `|` or `,`, each part made of letters, digits, `_`, `.`, `:`, `-` and `*`. A part is a name (compared without regard to case), a prefix when it ends in `*` (`Web*`), or a glob when a `*` stands anywhere else (`mcp__*__get_issue`, `*_task`).
  - **A regular expression**, tested unanchored and case-sensitively as written. It is tried for everything that is not a plain list, and also for a list whose text holds `.*` (`Bash.*`, `mcp__github__.*`), because those read differently as a prefix and as a pattern. A plain name (`job`, `read`) is never tried as a pattern: `job` does not fire for `wait_for_job`, and `read` does not fire for `create_task`.
  - **A pattern that does not compile fires for every name.** A guard that silently matches nothing is the failure to avoid, so an unreadable matcher errs towards running. `/hooks` says under the hook that its matcher cannot be read, and `namzu doctor` warns (`runtime.hooks`) and names it. A matcher written as `Tool(pattern)` (`Bash(git push *)`) is an `if`, not a matcher: it matches no tool name, so the hook never fires, and `/hooks` and `namzu doctor` say so and name the `if`. The same goes for an `if` that is not `Tool` or `Tool(pattern)`: it runs the hook, and both places say so.
  - **On a tool event** (and `permission_request`) a listed name is compared as the `if` filter compares its tool part: without regard to case, through the names skills write (`Bash` runs for the tool `bash`, `Edit|Write` for `edit` and `write`, `MultiEdit` for `edit`), without its `_` and `-` (`ViewImage` for `view_image`), and a bare tool-server name (`mcp__github`) stands for every tool of that server. `Task` and `Agent` stand for the sub-agent tool `Agent` and for `create_task`. A regular expression is tested against the tool's own name and also against each name skills write for that tool, so `Bash.*` and `^(Edit|Write)$` fire for `bash`, `edit` and `write`; it never matches less than it would against the tool's own name alone. `Bash.*` is unanchored, so it also fires for `job` (which skills write as `BashOutput` and `KillBash`).
  - **On the other events** (a notification's type, an agent's name, `source`, `reason`) a listed name is compared without regard to case and no tool alias is applied: those words are not tool names, so `Task` does not stand for `create_task` there. A regular expression there is tested as written.
  - Before `@namzu/sdk` 63 and `@namzu/cli` 52 a list compared the tool's name exactly, so `matcher: "Bash"` never matched `bash` and the hook never ran. Such a guard now runs; a hook that relied on not running for the capitalised spelling must say so with an `if` or a regular expression.
  - **What fires, for fifty-three matchers as people write them,** is pinned in `packages/sdk/src/plugin/__tests__/shell-hook-matcher-table.test.ts`, against every tool name the SDK defines and three tool-server tools. The ones people ask about:

    | `matcher` | Fires for |
    | --- | --- |
    | empty, `*`, `.*` | every tool |
    | `Bash`, `bash`, `BASH`, `^bash$`, `^Bash$` | `bash` |
    | `Edit\|Write`, `Edit,Write`, `^(Edit\|Write)$`, `(Edit\|Write)` | `edit`, `write` |
    | `MultiEdit` | `edit` |
    | `Read\|Grep\|Glob\|LS` | `read`, `grep`, `glob`, `ls` |
    | `Web*`, `WebFetch` | `web_fetch`, `web_search`; `web_fetch` |
    | `Task`, `Agent`, `Agent\|Task` | `Agent`, `create_task` |
    | `agent*` | `Agent`, `agent_task_list`, `create_task` |
    | `task_*` | `task_create`, `task_list`, `task_update` |
    | `*_task` | `cancel_task`, `continue_task`, `create_task`, `hand_back_task`, `wait_for_task` |
    | `read` | `read` only; `^read` also fires for `read_memory` |
    | `Bash.*` | `bash`, `job` |
    | `KillShell`, `TaskStop` | `job` |
    | `ViewImage`, `AskUserQuestion`, `ToolSearch` | `view_image`, `ask_user_question`, `search_tools` |
    | `mcp__github`, `mcp__github__*`, `mcp__github__.*` | every tool of the `github` server |
    | `mcp__.*`, `mcp__*` | every tool-server tool |
    | `mcp__slack__post_message` | that tool |
    | `mcp__.*__post_message`, `mcp__*__get_issue` | the tool of that name on any server |
    | `Read\|mcp__github__.*` | `read` and the `github` server's tools |
    | `Notebook`, `TodoWrite` | nothing: no such tool here |
    | `(unclosed`, `[` | every tool: the pattern cannot be read |
    | `Bash(git push *)` | nothing: that is an `if`, not a matcher; put it in `if` |
- `if` is a permission-rule filter on a tool event, checked before the process is spawned: `bash(git push *)`, `Bash`, `Edit`, `Edit(src/**/*.ts)`, `Read(*.env)`. The tool part takes every spelling a list `matcher` takes (see above): a name, the names skills write (`Task` and `Agent` name the sub-agent tool `Agent`, so `if: "Agent"` runs for it), names joined by `|` or `,`, a prefix or a glob (`mcp__github__*`), without regard to case. A regular expression is not read in `if`: use `matcher`. A bare tool name (no pattern) names that tool.
  - **A pattern on a shell tool** is a permission rule's pattern (`git push *`, `npm test`, `git push:*`), matched against the command line one command at a time: `cd x && git push` and `a; b | git push` are read command by command. What is evaluated for each command: the source text, the words after the shell removes quotes (`'git' push`), the command without its leading `NAME=value` assignments, and the same command with its wrappers peeled (`env`, `sudo`, `doas`, `nohup`, `command`, `exec`, `time`, `nice`, `timeout`, `stdbuf`, `xargs`, `busybox`, `watch`, `flock` (its lock file is skipped), and the command after `find -exec`; `parallel`, `script -c` and a shell alias are not peeled, so write the pattern for the wrapper too), its program named by its last path part (`/usr/bin/git push` is `git push`) and git's global options dropped (`git -C repo push` is `git push`). A command inside `bash -c '...'`, `$(...)` or a backtick pair is read as a command of its own. The hook runs if any of those matches. It also runs, whatever the pattern, for a line that cannot be read (an unclosed quote, `eval`), and for a command whose name is only known when the line runs (`$(echo git) push`, `$CMD push`): a filter only ever narrows when the whole line is visible. Text that is only data (`echo "git push"`, a here-document body, `git commit -m "push this"`) is not a command, and does not match. A pattern is the rule's own, so `rm -rf *` does not match `rm -fr x` and `npm test` does not match `npm test --silent`; write `npm test *` for that. `packages/sdk/src/plugin/__tests__/shell-hook-if-command-table.test.ts` pins fifty-seven conditions against command lines.
  - **A pattern on a file tool** (`Read`, `Edit`, `Write`, `Grep`, `Glob`, `LS`) is a path glob read exactly as a `permissions` path rule reads it, in the CLI: `*` stays inside one folder, `**` crosses folders, a pattern with no prefix is relative to the working folder, `/` is the project folder, `~/` the home folder, `//` an absolute path, and `./src/a.ts`, `src/a.ts` and the absolute spelling are one file. As in the permission rules, an `Edit` pattern covers `write` too and a `Read` pattern covers `grep`, `glob` and `ls`. A call with no path to compare, and a filter that means nothing for the tool, run the hook, so a guard is never switched off by a typo. A host that embeds the kernel supplies the path reading as `pathFilter` in the options of `attachShellHooks`; without one, a path pattern runs the hook.
- `once: true` runs the hook one time per session.
- `statusMessage` is shown on the terminal's status line while the hook runs.
- `onFailure` is `continue` (the default) or `block`. A hook fails when it could not start, timed out, exited with a code other than `0` or `2`, or printed JSON that does not read. `continue` logs it and lets the action go ahead; `block` counts the failure as exit `2`, so the action the event guards is refused with the failure as the reason; on `post_tool_use` and `post_tool_use_failure`, where the call has already run, it withholds the result instead (see `updatedToolOutput` above). It is not read on a `prompt` hook or an `async` command. On `pre_compact` this is the way to make a compaction guard hold: with the default, a hook that printed JSON that does not read, exited with another code or timed out lets the compaction go ahead (it has not said no); with `onFailure: block` the pass is refused, as for an exit `2`.
- `toolNames` is `namzu` (the default) or `written`, and says which spelling of a tool's name the hook is sent as `tool_name` and `NAMZU_TOOL_NAME`, and inside `tool_calls` on `post_tool_batch`: Namzu's own (`bash`) or the name a person writes in a matcher (`Bash`). See [Tool names](#tool-names). Nothing else in what the hook receives depends on it, and `matcher` and `if` read either spelling whatever it says. An entry read from the common shape (see [A hooks block in the common shape](#a-hooks-block-in-the-common-shape)) is `written`; an entry of ours with no `toolNames` keeps receiving ours, and `/hooks` shows which each entry gets. It is `ShellHookEntryBase.toolNames` in the SDK.
- `timeoutMs` is the deadline (ten minutes by default and at most; before `@namzu/sdk` 52 the default was 30 s, so set `timeoutMs: 30000` to keep it). The lifecycle manager's own per-hook limit (`hookTimeoutMs`) defaults to the same ten minutes. A host that embeds the kernel can give an event a shorter default for entries that set no `timeoutMs`, with `defaultTimeoutMs` (an object keyed by event) in the options of `attachShellHooks`, and be told of a hook that ran out its deadline with `onTimeout`; an entry's own `timeoutMs` is honoured as written, and without the options nothing changes. The command line sets five seconds for `session_end` this way.

- `env` (a command entry only; the other kinds start no process) is a mapping of variable names to text that the command is started with, in addition to the variables above. A name is letters, digits and underscores, not starting with a digit, and a value is text; a value may use `$NAME` or `${NAME}` of a variable the hook already has (`"${NAMZU_PROJECT_DIR}/tools"`, `"/extra:$PATH"`) and any other text, including a name it does not have, stays as written. It replaces an inherited variable of the same name. The variables Namzu sets for every hook (`NAMZU_HOOK_EVENT`, `NAMZU_SESSION_ID`, `NAMZU_PROJECT_DIR`, `NAMZU_TURN_ID`, `NAMZU_TOOL_NAME`, `NAMZU_TOOL_PATH`, `NAMZU_STARTED_BY_SESSION`) cannot be replaced: a config that tries is refused in our own shape and, in the common shape, the name is left off with a note. `env` is read in both shapes, listed by `/hooks` (the names, never the values), shown by the trust prompt beside the command (names only), and part of what makes two entries the same. Use it for a script that reads a moved variable inside its own file: `{ "command": "./inner.sh", "env": { "SOMETOOL_PROJECT_DIR": "${NAMZU_PROJECT_DIR}" } }`. In the common shape a bad name or a value that is not text is left off with a note and the hook still runs; an `env` that is not a mapping is left off the same way.
- **When a hook cannot find its program.** If a command exits `127`, could not be started because the program was missing, or says "no such file" or "not found", and its command text refers to a variable that is set nowhere (not in the environment, not by `env`, not filled in by the `_PROJECT_DIR` rule, not given a default, not assigned by the command itself), the failure line names the variable and the `env` key: `its command refers to $SOMETOOL_PLUGIN_ROOT, which is not set for hooks: give it a value with the entry's "env" key`. On an entry with `onFailure: block` the sentence is in the reason the model is given; otherwise it is the hook's warning in the log. `namzu doctor` (the `runtime.hooks` row) says the same before anything fails, for every attached command entry whose text refers to such a variable, and warns.

Entries of one event run in parallel; see above for how their answers combine.

### Other kinds of hook

An entry is a command unless it says `type`. All the options above apply to every kind.

- **Exec form** (`command` with `args`). `command` is the program and `args` its arguments, spawned directly with no shell, so a path with a space, a quote or a `$` is passed exactly as written. `args: []` runs the program with no arguments.
- **`async: true`** on a command. The command is started and the turn carries on; its exit code and output decide nothing and a failure is only logged. It is not killed when the turn ends, only by its deadline, and the deadline is kept by the program that started it: when that program exits first (`namzu exec` ends, the terminal closes) an `async` command that is still running is left running, as any program started in the background would be, so an `async` `session_end` hook should end on its own. A hook that should be able to refuse is not async.
- **`type: http`** with `url`. The event JSON is posted to `url` (`http` or `https`) and a 2xx body is read as the hook's answer exactly as a command's stdout is; any other status, a network error and the deadline are the hook failing. `headers` are added to the request, and a value may use `$NAME` or `${NAME}` for an environment variable listed in `allowedEnvVars`; any other reference becomes empty, and line breaks in a value are dropped. A name that resolves to a private or link-local address is refused where the connection is made (loopback is allowed, for a local service), and redirects are not followed.
- **`type: prompt`** with `prompt`. The small model is asked whether a condition holds. `$ARGUMENTS` in the text is replaced by the event JSON (the event follows the text when there is no placeholder), and the model answers `{"ok": true}` or `{"ok": false, "reason": "..."}`. `false` refuses as exit `2` does, with the reason. No small model, an error, the deadline (30 seconds by default) or an answer that does not read lets the action go ahead. The question is put on the model the host supplies as `judge` in the options of `attachShellHooks`; without one a prompt hook does nothing.

### Where shell hooks differ from the common hook contract

The JSON answer, the exit codes and the options above follow the JSON hook contract. These differences are deliberate:

- **A hook's `allow` is narrower.** It never covers a sandbox escape, a path outside the roots, a call the tool always asks about, an explicit review rule's call or a destructive call, and it never reopens a deny. A hook `deny` always wins.
- **A rewrite is checked twice.** `updatedInput` is validated like a model-supplied input and then authorized as the rewritten call, so a rewrite can neither slip past a rule nor reach a tool whose schema refuses it.
- **`permission_request` fires for every call that would have gone to the review policy,** whatever the mode: in `auto` nobody is asked, and a `permission_request` hook still runs and its `skip` still refuses. It fires whether or not a dialog is shown. `notification` is fired by the terminal application only, not by `namzu exec`.
- **One compaction is out of reach.** `pre_compact` can cancel a pass the threshold asked for, or refuse one a person asked for, and not one the provider forced.
- **The order of answers is deterministic.** Answers are read in priority and registration order, so which refusal is quoted and which rewrite wins never depends on timing.
- **Three events observe and decide little.** `permission_denied` and `turn_failure` take no verdict; `post_tool_batch` takes `continue: false` (and `error` from an in-process hook) and ignores `additionalContext`. `turn_failure` is spelled `StopFailure` in `hook_event_name`; a `matcher` on `permission_denied` names the tool, and on the other two it matches only as `*`. `subagent_start` is not observational: its `additionalContext` reaches the child before the prompt, and an in-process hook's `error` fails the child turn.
- **`post_tool_use_failure` is in addition to `post_tool_use`,** which keeps firing for a failed call as it always did; a failed call fires both events.
- **Not delivered:** `updatedInput` from a `permission_request` allow, `permissionDecision: "defer"` (it decides nothing), `updatedToolOutput` on any event but `post_tool_use` and `post_tool_use_failure`, `sessionTitle` and the other fields that have no counterpart here. `updatedMCPToolOutput` is read for tool-server tools only, and `updatedToolOutput` wins when both are set (see `updatedToolOutput` above). `agent` and `mcp_tool` hook types do not exist here, and a command's `asyncRewake` (waking the model when a background hook exits `2`) is not offered.
- **The values a moved script must expect.** The field names above are the common ones; these values are Namzu's:
  - **Tool names** (`tool_name`, `NAMZU_TOOL_NAME`, `matcher`) are Namzu's own, in lower case, with one exception: the command line's sub-agent tool is named `Agent`. A script that tests `tool_name == "Bash"` never matches an entry of ours: test `bash`, or give the entry `toolNames: written` (see [Tool names](#tool-names)); an entry read from the common shape already receives `Bash`. The SDK defines these tools (the list is checked against the source by `shell-hook-docs-tool-names.test.ts`, so it cannot drift); a tool server's tools are `mcp__<server>__<tool>`:

    <!-- tool-names:start -->
    - Files and shell: `bash`, `edit`, `glob`, `grep`, `job`, `ls`, `read`, `verify_outputs`, `view_image`, `wait_for_job`, `write`
    - Code and analysis: `code_analysis`, `lsp`, `run_code`, `structured_output`
    - Web, browser and computer: `browser`, `browser_act`, `computer_use`, `monitor`, `web_fetch`, `web_search`
    - Skills and tool search: `search_tools`, `skill`
    - Agents and tasks: `Agent`, `agent_task_list`, `approve_plan`, `ask_user_question`, `cancel_task`, `continue_task`, `create_task`, `hand_back_task`, `task_create`, `task_list`, `task_update`, `update_plan_step`, `wait_for_task`
    - Goals, schedules and memory: `delete_memory`, `get_goal`, `read_memory`, `save_memory`, `schedule`, `search_memory`, `session_loop`, `update_goal`, `update_memory`
    - Advisors, pals, connectors and knowledge: `connector_execute`, `connector_list`, `consult_advisor`, `import_reference_images`, `knowledge_search`, `list_advisors`, `list_pals`, `send_pal_message`
    <!-- tool-names:end -->

    Which of them a session offers depends on the host and its settings; the default set is `bash`, `edit`, `glob`, `grep`, `job`, `read`, `verify_outputs`, `wait_for_job` and `write`. `matcher` and `if` accept the names skills write (`Bash`, `Read`, `Edit`, `Write`, `MultiEdit` for `edit`, `Grep`, `Glob`, `LS`, `WebFetch`, `WebSearch`, `Skill`, `AskUserQuestion`, `Task` and `Agent` for the sub-agent tool and `create_task`, `LSP`, `ToolSearch`, `BashOutput`, `TaskOutput`, `KillShell`, `KillBash` and `TaskStop` for `job`, `TaskCreate`, `TaskUpdate`, `TaskList`) without regard to case; a regular expression in `matcher` is also tried against those names (see `matcher` above).
  - **A file tool's input names its file `path` and `file_path`, with the same value.** `read`, `write`, `edit`, `ls`, `view_image` and `lsp` take `path`, and `grep` and `glob` take an optional `path` (the file or folder searched; the folder in `glob`) beside `pattern`; a script that reads `.tool_input.file_path` finds the same string. `path` stays, so no script changes. `write` also has `content`, `edit` has `old_string` and `new_string` (or `edits`), and `bash` has `command` (and may carry `timeout`). A tool server's tools get no added key: their input is whatever their schema says. When a `pre_tool_use` hook answers with `updatedInput`, an echoed `file_path` is never a reason to refuse it and the tool never sees it: when only one of the two keys differs from what the hook was sent, that value is the new path; when both differ and agree, that is the path; when both differ and disagree the answer is unreadable (it follows `onFailure`: the original call runs with `continue`, the call is refused with `block`). `NAMZU_TOOL_PATH` is the `path` value; for an input that has none it is `file_path` or `filePath` when one is a non-empty string.
  - **`tool_response`** (and `tool_result`, the same object) is an object `{ "success": true | false, "output": "<text>" }` with an `error` string when the call failed, never a bare string; `output` is the text the model reads. In `tool_calls` on `post_tool_batch`, `tool_response` is that text as a string.
  - **A single-call event carries `tool_use_id`.** `pre_tool_use`, `post_tool_use`, `post_tool_use_failure`, `permission_request` and `permission_denied` send the id the model gave the call, the same one the matching entry of `tool_calls` on `post_tool_batch` has, so a script pairs a before with an after on `tool_use_id`. The id exists when the call is read from the model's reply, before any of those events, so every one has it. The exception is a call a tool makes through `dispatchTool` (a nested call): it has no model-issued id, `pre_tool_use` fires for it without one, and the field is absent. In process the id is `PluginHookContext.toolCallId`, optional.
  - **`source`** on `session_start` is `startup` or `resume`; **`reason`** on `session_end` is `exit` or `replaced` (and on `permission_denied` it is the text of why the call was refused). There is no `clear` source: `/clear` does not fire `session_start` again.
  - **A variable written for another tool.** A name ending in `_PROJECT_DIR` that a command or its arguments refer to and that is not set is filled in with the project folder (see [the environment above](#shell-hooks)). A folder variable of another ending, or one a script reads inside its own file, is not covered: give it with the entry's `env` key, for example `"env": { "SOMETOOL_HOME": "${NAMZU_PROJECT_DIR}/.tool" }`. Which endings are read is the table `MOVED_FOLDER_ENDINGS`; today it holds `_PROJECT_DIR`.
  - **`agent_type`** on `subagent_start` and `subagent_stop` is the agent's name (`reviewer`, `explore`, `general-purpose`), on both events and on every way a child's turn ends; `agent_id` is the child's session id.
- **`matcher` keeps its glob.** A name ending in `*` is a prefix, as it has been; a regular expression would read the same text differently.

### Tool names

A hook is sent the name a tool is registered under (`bash`, `web_fetch`), or, when its entry says `toolNames: written`, the capitalised name a person writes in a matcher for that tool (`Bash`, `WebFetch`). There is one table, in `packages/sdk/src/plugin/shell-hook-tool-names.ts` (`SHELL_HOOK_WRITTEN_TOOL_NAMES`, with `shellHookToolName` beside it), and this page lists exactly its rows; `shell-hook-written-tool-names.test.ts` fails when the two differ.

<!-- written-tool-names:start -->
| Our tool name | Written name |
| --- | --- |
| `Agent` | `Agent` |
| `ask_user_question` | `AskUserQuestion` |
| `bash` | `Bash` |
| `edit` | `Edit` |
| `glob` | `Glob` |
| `grep` | `Grep` |
| `ls` | `LS` |
| `lsp` | `LSP` |
| `monitor` | `Monitor` |
| `read` | `Read` |
| `search_tools` | `ToolSearch` |
| `skill` | `Skill` |
| `task_create` | `TaskCreate` |
| `task_list` | `TaskList` |
| `task_update` | `TaskUpdate` |
| `web_fetch` | `WebFetch` |
| `web_search` | `WebSearch` |
| `write` | `Write` |
<!-- written-tool-names:end -->

- **A tool with no common name keeps ours**: `job`, `view_image`, `create_task`, `read_memory`, `schedule` and the rest of the list above. `create_task` is not `Task`: the sub-agent tool is `Agent`, and `matcher: "Task"` still fires for both.
- **A tool-server tool is never changed**: `mcp__<server>__<tool>`.
- **Only the name changes.** The call id (`tool_use_id`), `tool_input` with its `file_path`, `tool_response` and every other field are the same for both spellings.
- `matcher` and `if` do not depend on it: `Bash`, `bash` and `^Bash$` fire for the same calls whichever spelling the hook is sent.

## In the CLI

The `hooks` key of a config file is event → list of hooks: `{ command, args?, async?, matcher?, timeoutMs?, if?, once?, statusMessage?, onFailure?, toolNames? }`, `{ type: http, url, headers?, allowedEnvVars?, … }` or `{ type: prompt, prompt, … }`. In the terminal a `prompt` hook uses the small model and its tokens count against the turn it fired in; it is not asked outside a turn (`session_start`, `session_end`). The session fires `session_start` before its first turn — once the conversation has its durable session id, which every later turn's hooks carry as `session_id`, so a hook can match them — and `session_end` when it closes, including on `/exit`, which now closes the session before the process leaves.

**`session_end` hooks have five seconds.** Closing a session waits for its `session_end` hooks, so a hook that hangs would hold `/exit` (or the end of `namzu exec`) for the ordinary ten minutes. An entry with no `timeoutMs` is given five seconds in the terminal application, `namzu exec` (with and without `--json`) and every other host of the command line, since all of them close a session in one place; an entry's own `timeoutMs` is honoured as written (up to the ten-minute cap). The terminal waits for the close up to five seconds for everything else it closes plus the longest `session_end` deadline among the entries it will wait for, so a hook that is given 20 seconds is given 20 seconds there too and `/exit` leaves only after the hook has finished or been ended. An `async` entry is not waited for and has no part in that time. When the deadline is hit the session still closes, the hook's process is ended the way any timed-out hook is, and one line on standard error says which hook did not finish (`The session_end hook \`<command>\` did not finish within 5 seconds and was ended.`). The line goes to standard error, so `namzu exec --json` keeps its standard output as events only. Other events keep the ten-minute default. A hook's `statusMessage` shows on the status line while it runs, in the terminal application only: `namzu exec`, the ACP host and a scheduled run draw no status line, so the text appears nowhere there. A hook that stops the turn or warns the operator leaves a line in the transcript, and `notification` hooks hear about every review that waits and every turn that settles, whether or not a terminal notification is configured.

### A hooks block in the common shape

The `hooks` key reads the shape other hook files are written in, beside ours, in the same key: an event in its PascalCase spelling (`PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `PermissionRequest`, `PermissionDenied`, `Notification`, `PreCompact`, `PostCompact`, `PostToolBatch`, `PostToolUseFailure`, `StopFailure`, `SessionEnd`; the same words `hook_event_name` sends) holding a list of groups, a group having an optional `matcher` and a list `hooks`, each hook having a `type`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "./guard.sh", "timeout": 5 }] }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "./done.sh" }] }]
  }
}
```

- **How a hook is read.** Each inner hook becomes one entry of ours for that event. The group's `matcher` goes on each of its hooks; `type` is `command` (the default), `http` or `prompt`; `command`, `args`, `async`, `env`, `if`, `once`, `statusMessage` and `onFailure` carry over; `timeout` is in seconds and becomes `timeoutMs` (`2.5` is 2 500); `http` takes `url`, `headers` and `allowedEnvVars`, and `prompt` takes `prompt`. The entry is `toolNames: written`: a script that tests `tool_name == "Bash"` and reads `tool_input.command` or `tool_input.file_path` works as it is.
- **Both shapes in one file.** Our events (`pre_tool_use`) hold flat entries and the PascalCase ones hold groups; either spelling may hold either, and the same event may be written both ways in one file: the entries join, in the order they are written. An entry of ours under `PreToolUse` and a group under `pre_tool_use` are read too. Two entries that read the same (the same event, and every option the same, `toolNames` included) run once, as they do across files, whichever shape they were written in.
- **The answer needs no switch.** An answer is read the same whichever shape the entry was written in; `hookSpecificOutput.hookEventName` takes either spelling of the event.
- **Nothing is dropped in silence.** What cannot be loaded or acted on is said in plain words, naming the file, the event and what will not happen, three ways: once at launch (a warning), under `/hooks`, and in the `runtime.hooks` row of `namzu doctor`.
  - An event name with no counterpart here (`TeammateIdle`, `ConfigChange`, any other PascalCase name that is not in the list above): none of its hooks will run. It is a **problem**: the row warns.
  - A hook kind we do not have (`agent`, `mcp_tool`, anything but `command`, `http` and `prompt`), a hook with no `command`, `url` or `prompt` it needs, an `http` `url` that is not an `http` or `https` address, `args` that are not a list of text, an entry that is not a mapping: that hook will not run. It is a **problem** when its event can guard something (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `UserPromptSubmit`, `PreCompact`, `Stop`, `SubagentStart`, `SubagentStop`), and the line says what it was meant to guard is not checked; elsewhere it is a **note**.
  - A key this kernel does not act on (a group's other keys, `shell`, `asyncRewake`, `model` and so on) is a **note**; the hook still loads and runs without it.
  - **An unreadable setting never switches a hook off.** A `timeout`, `if`, `once`, `statusMessage`, `onFailure`, `headers`, `allowedEnvVars`, `async`, `env` (or a name or value inside it) or group `matcher` of the wrong type is left off, with a note, and the hook runs, for more calls and with the default deadline, never fewer.
- **One unreadable entry does not stop the others.** The rest of its group, its event and its file load. (A file that holds a misspelt event of our own shape, such as `on_save`, a renamed event, or an entry of ours with a bad value is still refused whole with the message it always gave: that is a mistake in a shape we define, not a hook we cannot read.)
- **Before a folder is trusted** the terminal's trust prompt and the Desktop app's trust dialog read the common shape too, so a hook written in it (the command, the address or the question inside a group) is named before it can run. A project file's hooks in either shape obey the same switches (`disableHooks`, `hooksManagedOnly`, `NAMZU_DISABLE_HOOKS`) and the same trust.
- **In the SDK.** `attachShellHooks` takes entries of our shape only; reading the common shape belongs to where a host reads its config. The CLI's reader is its own; a host that embeds the kernel can use `SHELL_HOOK_PASCAL_EVENT_NAMES` (the table of PascalCase event names), `SHELL_HOOK_WRITTEN_TOOL_NAMES` and `toolNames` on its entries.

### Hooks from several files combine

For each event the entries of every file are attached. The order is fixed, and it is the order the kernel reads answers in (the first refusal quoted is the earliest file's; of several rewrites the last wins, so the managed file's word comes last):

1. `~/.namzu/config.yaml` (the user file)
2. `namzu.config.json` of the project
3. `namzu.config.local.json` of the project
4. the selected profile's `hooks` (`--profile`, `NAMZU_PROFILE`), after the files it is declared in
5. the organisation-managed file (`/etc/namzu/config.json`; `%PROGRAMDATA%\namzu\config.json` on Windows)

Within one file the entries keep the order the file gives them.

- **An entry that is identical in two files runs once.** Two entries are identical when they are for the same event and every option reads the same (`command`, `args`, `type`, `matcher`, `timeoutMs`, `if`, `once`, `statusMessage`, `onFailure`, `toolNames`, `async`, `env` (in whatever order its names were written), `url`, `headers`, `allowedEnvVars`, `prompt`); where they were declared does not count, and `type: command` is the same as no `type`. The copy in the earliest file is the one attached and the one `/hooks` names. Entries that differ in any option are different entries and both run.
- **Every attached entry remembers its file** (`source`), shown by `/hooks` and counted per file by `namzu doctor`.
- **Trust does not change.** Entries from the project's files attach only after the folder is trusted: the terminal asks, `namzu exec` refuses with exit 77 unless the folder is trusted or `--trust` is given. Before that only the user and managed files are read. The terminal's trust prompt lists the hooks the folder's two files declare, in either shape (their event and what they would run: at most eight, the rest counted, each bounded) before the choice.
- **What this changed.** Before `@namzu/cli` 52 the highest file that had a `hooks` key replaced the whole key: a project file with one hook switched off every hook in the person's own file, so a cloned repository's hooks, once trusted, silently displaced the person's guard hooks, and a managed file with a `hooks` key discarded the rest. Now all of them run. To keep the old result, remove the hooks that should not run from the file they are in, or turn them off for one run with `NAMZU_DISABLE_HOOKS=1`.

### Switches

- `disableHooks: true` (in the user file, or in the managed file) or `NAMZU_DISABLE_HOOKS=1` (for one run; `0` and `false` leave it as the files say) turns off every hook that comes from the user, project and local files, profiles in them included. Hooks of the organisation-managed file keep running. A `disableHooks` in a project or local file (or a profile declared there) is ignored, with a note at launch: a repository cannot switch off the hooks you set up. Once the user file, the environment or the managed file says `true`, no later file turns it back off. **The JavaScript hooks of plugins are not touched**: plugins have their own on and off (`plugins.enabled`, `/plugins`).
- `hooksManagedOnly: true`, in the organisation-managed file only, attaches only that file's hooks: entries from the user, project and local files are not attached. A user, project or local file that sets it is ignored, and the launch says so once.
- While either is in force, `/hooks` says so in its first line, and `namzu doctor` has a `runtime.hooks` row that counts the shell hooks attached per file, says whether a switch is on, and warns, naming each, about a `matcher` or `if` that cannot be read and about a hook a file declared that could not be loaded (see [A hooks block in the common shape](#a-hooks-block-in-the-common-shape)). A project's hooks that are declared but not attached because the folder is not trusted are reported there as not attached.

### `/hooks`

`/hooks` lists every hook attached, by event, each with the file it came from and its matcher, `if`, `once`, deadline, background and `onFailure` options, the names a command entry's `env` sets, and on a tool event which tool names it receives (`Namzu's own (bash)` or `as written (Bash)`) (and, under a hook whose `matcher` is not a regular expression that compiles or whose `if` is not `Tool(pattern)`, a line saying it cannot be read and what that means); then what the files declared that could not be loaded or was not acted on (`Not loaded:` for a hook that would have guarded something, `Note:` otherwise), then the hooks plugins registered, as the event and the plugin's name (`pre_tool_use · plugin review-bot`). A plugin that is disabled registers none.

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

## Compaction hooks

`pre_compact` and `post_compact` fire for every pass: one the kernel started because the context neared its limit (`reason` `threshold`), one it started because the provider rejected the prompt (`overflow`), the idle pass a host runs on a conversation nobody is using, and a pass a person asked for (`/compact`, or summarising a span from the rewind dialog). The payload is the same for all of them and says which it is:

- `trigger` is `manual` for a pass a person asked for and `auto` for every pass the kernel or a host started on its own, the idle pass included. A `matcher` on either event tests it. For a pass a host runs outside a turn `reason` is `manual`; test `trigger`, not `reason`, to tell a person's request from the kernel's own.
- `pre_compact` carries the words the person typed with the command in `instructions` (`custom_instructions` in the shell payload), or `null`.
- `post_compact` carries the summary the pass wrote in `summary` (`compact_summary` in the shell payload), cut to 8000 characters with `[truncated]` marking a cut; it is absent when the pass wrote none (a context reducer reduced the history, or the pass shed nothing). `post_compact` decides nothing. For a pass a person asked for, it runs after the pass is made, and its answer is not read: a hook that fails does not undo the pass.

**A refusal.** `skip` (exit `2`, or `decision: "block"`) cancels a pass the threshold asked for, as before. It also refuses a pass a person asked for: nothing is summarised, nothing is written to the conversation, and the person sees one line, `A hook refused the summary: <reason>`. An idle pass a hook refuses is cancelled without a message. A pass the provider forced cannot be refused. A manual pass with nothing to shed fires no hook.

**What to keep.** Plain text a `pre_compact` hook prints with exit `0`, `hookSpecificOutput.additionalContext` in its JSON answer, and, for a hook written in-process, the `annotate` result (or `continue` with `context`) are given to the summariser as instructions, after the person's own, framed as `Context from the operator's hooks:` the way session-start context is. Several hooks contribute in the order answers are read in, joined with a blank line and cut to 8000 characters in all. This holds for a pass a person asked for and for the kernel's own. Words from a hook that refused a forced pass (which runs regardless) are still heard. The summariser gets them in the model-written summary and in the verification step; because a hook asked for them, the verification step runs even where `llmVerification` is off, the way it does for the person's own words. Where a pass has no summariser, the words have nowhere to go: a context reducer owns the reduction and the pass uses no summary at all. A hook that prints to stdout on `pre_compact` for its own log now has that text sent to the summariser: print to stderr, or to a file, instead.

## The last message

`turn_end` and `subagent_stop` carry `lastAssistantMessage` (`last_assistant_message` in the shell payload): the text of the model's last message of the turn, on both ways a turn ends (the model finishing with nothing to run, and every other way, such as an iteration limit). It is the last assistant message after the operator's latest prompt, cut to 8000 characters with `[truncated]` marking a cut. It is absent when that message has no text, which is when the turn ended on a tool call, was interrupted or failed before the model wrote anything, or has no assistant message yet; an earlier step's narration or an earlier turn's reply is never given in its place. After a `skip` has kept the turn going, the next ask carries the newest reply.
