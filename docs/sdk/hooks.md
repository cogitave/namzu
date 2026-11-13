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
| `file_changed` | by the host, once a watched file has been still for about half a second (see [Files and folders](#files-and-folders-and-variables-for-later-commands)) | `filePath`, `change` (`change`, `add` or `unlink`) | nothing is refused and nothing reaches the model; a hook may hand back `watchPaths` and a `systemMessage` |
| `cwd_changed` | by the host, when the folder the session's shell commands start in is a different folder from before | `oldCwd`, `newCwd` | the same as `file_changed` |
| `worktree_create` | by the host, when a worktree is about to be made: a sub-agent that works in its own checkout, `namzu worktree create` and `fork`, `/worktree create` (see [Worktrees](#worktrees)) | `worktreeName` (the suggested name), `worktreeRoot` (where a relative path is placed), `worktreeBaseRef` when a start was asked for | the hook makes the worktree and answers its path; a failure, or no path, fails the creation |
| `worktree_remove` | by the host, when a worktree is about to be removed | `worktreePath` | the hook does the removing; a failure is reported |
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
- **The end hook of a conversation left behind** runs at once and has the same deadline as on exit: five seconds in the CLI when the entry names none, its own `timeoutMs` otherwise. It never holds the new conversation back, which starts without waiting for it; the program leaving waits for it, for no longer than its deadline, and only then runs the end hook of the conversation it leaves, so the ends are told in the order they happened and two end hooks never run at the same time.
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
- **Variables a moved command expects.** A command written for another tool often starts with a variable for the project folder named for that tool (`"$SOMETOOL_PROJECT_DIR/.hooks/check.sh"`). When an entry's `command` or `args` refer to a variable written `$NAME` or `${NAME}` that is not set in the environment the hook is started with, and whose name ends in `_PROJECT_DIR`, the hook is started with that variable set to the project folder (the value of `NAMZU_PROJECT_DIR`). The rule reads the shape of the name, not a list of tools. A name that is already set, even to an empty string, is never overwritten; `${NAME:-default}` and the other forms with a default are read the same way. A shell entry's command reads the variable itself, so the script it starts sees it too; an entry in the exec form (`args`) has no shell, so the variable is also put into the text of `command` and of each argument (`$NAME` and `${NAME}`; a reference with a modifier such as `${NAME:-x}` is left as written). The name is looked for in the entry's own `command` and `args` text, and nowhere else: a script that reads such a variable without the entry naming it cannot be seen from here, and needs the entry's `env` key (see [Options on an entry](#options-on-an-entry)). The shell that reads a command is found on the host's own `PATH`, so an `env` that sets `PATH` to something without `sh` still starts the command. Names a shell keeps for itself (`RANDOM`, `PPID`, `UID`, `PWD`, `OPTIND`, `BASH_SOURCE` and the rest) and variables the command makes with `NAME=`, `for`, `select`, `read` or `getopts` are never reported as unset. An entry that refers to no such variable starts with exactly the environment it always had.
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

- `env` (a command entry only; the other kinds start no process) is a mapping of variable names to text that the command is started with, in addition to the variables above. A name is letters, digits and underscores, not starting with a digit, and a value is text; a value may use `$NAME` or `${NAME}` of a variable the hook already has (`"${NAMZU_PROJECT_DIR}/tools"`, `"/extra:$PATH"`) and any other text, including a name it does not have, stays as written. It replaces an inherited variable of the same name. The variables Namzu sets for every hook (`NAMZU_HOOK_EVENT`, `NAMZU_SESSION_ID`, `NAMZU_PROJECT_DIR`, `NAMZU_TURN_ID`, `NAMZU_TOOL_NAME`, `NAMZU_TOOL_PATH`, `NAMZU_ENV_FILE`, `NAMZU_STARTED_BY_SESSION`) cannot be replaced: a config that tries is refused in our own shape and, in the common shape, the name is left off with a note. `env` is read in both shapes, listed by `/hooks` (the names, never the values), shown by the trust prompt beside the command (names only), and part of what makes two entries the same. A name that ends in `_ENV_FILE` and is not set is given the same file as `NAMZU_ENV_FILE`, on the events that have one (`session_start`, `cwd_changed`, `file_changed`; see [Variables for later commands](#variables-for-later-commands)), so a command written to append to `$SOMETOOL_ENV_FILE` appends to the file Namzu reads; on any other event the name stays unset and is named when the command fails to find its program. Use it for a script that reads a moved variable inside its own file: `{ "command": "./inner.sh", "env": { "SOMETOOL_PROJECT_DIR": "${NAMZU_PROJECT_DIR}" } }`. In the common shape a bad name or a value that is not text is left off with a note and the hook still runs; an `env` that is not a mapping is left off the same way.
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
  - **A variable written for another tool.** A name ending in `_PROJECT_DIR` that a command or its arguments refer to and that is not set is filled in with the project folder (see [the environment above](#shell-hooks)). A folder variable of another ending, or one a script reads inside its own file, is not covered: give it with the entry's `env` key, for example `"env": { "SOMETOOL_HOME": "${NAMZU_PROJECT_DIR}/.tool" }`. Which endings are read is the table `MOVED_FOLDER_ENDINGS`; it holds `_PROJECT_DIR` (the project folder) and, for an entry a plugin ships only, `_PLUGIN_ROOT` and `_PLUGIN_DATA` (see [Hook entries a plugin ships](#hook-entries-a-plugin-ships)).
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
- **Trust does not change.** Entries from the project's files attach only after the folder is trusted: the terminal asks, `namzu exec` refuses with exit 77 unless the folder is trusted or `--trust` is given. Before that only the user and managed files are read. The terminal's trust prompt lists the hooks the folder's two files declare, in either shape, and the hooks its skills and agent files carry (their event and what they would run: at most eight, the rest counted, each bounded) before the choice.
- **What this changed.** Before `@namzu/cli` 52 the highest file that had a `hooks` key replaced the whole key: a project file with one hook switched off every hook in the person's own file, so a cloned repository's hooks, once trusted, silently displaced the person's guard hooks, and a managed file with a `hooks` key discarded the rest. Now all of them run. To keep the old result, remove the hooks that should not run from the file they are in, or turn them off for one run with `NAMZU_DISABLE_HOOKS=1`.

### Hook entries a plugin ships

A plugin can carry hook entries (a command, an http address or a prompt) as well as JavaScript hook modules. They are read by the same reader a config file's `hooks` key goes through, so either shape works, a problem is said in the same words, and a plugin written for the common hook contract moves as written.

**Where the entries are read from.** In this order, each when it exists:

1. `hooks/hooks.json` in the plugin folder, the conventional place.
2. Each path in the manifest's `hooks` that ends in `.json`. `hooks` keeps meaning what it meant: a list of paths inside the plugin, where a path ending in `.json` is a file of entries and any other path is a JavaScript module exporting a `hooks` array. Its type does not change. The two spellings the common hook contract uses are read as the keys above: `"hooks": "./hooks/hooks.json"` (one text) is a list of one path, and `"hooks": { <events> }` (the events object written inline) is `hookEntries`. A manifest that has both an inline `hooks` object and `hookEntries` is refused, so neither is dropped.
3. The manifest key `hookEntries`: the same events object written inline.

A file holds the events object itself (`{ "pre_tool_use": [...] }`, or `{ "PreToolUse": [...] }`) or an object with a `hooks` key holding it (`{ "description": "...", "hooks": { "PreToolUse": [...] } }`). Both are read; any other key beside `hooks` is a note and is not acted on. Our shape and the common shape may be mixed in one file, as in a config file.

```json
{
  "name": "review-bot",
  "version": "1.0.0",
  "description": "Guards shell calls",
  "hooks": ["hooks/more.json", "hooks.mjs"],
  "hookEntries": { "Stop": [{ "hooks": [{ "type": "command", "command": "${NAMZU_PLUGIN_ROOT}/bin/done.sh" }] }] }
}
```

**The plugin's own folders.** A command a plugin ships is started with `NAMZU_PLUGIN_ROOT` (the plugin's folder) and `NAMZU_PLUGIN_DATA` (a folder kept for the plugin under the Namzu home, `plugin-data/user/<name>` for a user plugin and `plugin-data/project/<name>-<key>` for a project one, where the key comes from the plugin's folder so a repository never reaches the data of a plugin of the same name you installed). The data folder is created when a command first runs, is never inside the plugin folder (an entry whose data folder would overlap the plugin's is not attached and is reported), and survives the plugin being disabled. A shell command expands them itself: the variables are in its environment, so a folder name with a quote, a space or `$(...)` in it is never read as shell text. `${NAMZU_PLUGIN_ROOT}` and `${NAMZU_PLUGIN_DATA}` (and the bare `$NAME` form) are replaced in the command and every argument only for an entry in the exec form, which no shell reads. A reference with a modifier (`${NAMZU_PLUGIN_ROOT:-x}`) is left as written for the shell.

The rule by the shape of a name (see [A variable written for another tool](#where-shell-hooks-differ-from-the-common-hook-contract)) extends to a plugin's entries: a variable the command or its arguments refer to that is not set and whose name ends in `_PLUGIN_ROOT` or `_PLUGIN_DATA` is given the plugin's folder or data folder, under the name the command used (`MOVED_FOLDER_ENDINGS` holds the endings), so a script the command starts reads it by that name. A variable a script reads that the command never names is not seen; give it with the entry's `env`: `"env": { "SOMETOOL_PLUGIN_DATA": "${NAMZU_PLUGIN_DATA}" }`.

**A config file's entry that names a plugin variable still runs.** In a config file no plugin gives a folder, so a name ending in `_PLUGIN_ROOT` or `_PLUGIN_DATA` there is set only if the entry's `env` or the environment sets it; otherwise it is empty, as it always was, and the command is started. A command that tests it (`[ -z "$X_PLUGIN_DATA" ]`) or prints it works as before. It is named as a note at launch, in `/hooks` and in `namzu doctor`, so the empty value is not a surprise. When such a command cannot find its program, the failure line names the variable and the `env` key, and the `runtime.hooks` row of `namzu doctor` warns about the reference.

**They live as long as the plugin is on.** Enabling a plugin (`/plugins`, the saved start-up state, `--plugin-dir`) reads its entries and attaches them under the plugin's id; disabling it removes them at once with its JavaScript hooks, and nothing of a disabled plugin runs. A plugin that is already on cannot be enabled again, so its entries are never attached twice. An entry the plugin lists twice (in `hooks/hooks.json` and in `hookEntries`, say) runs once. An entry equal to one from a config file runs as well: **the source is part of the identity**, so the plugin's entry and the config file's are two entries, and so are the same text shipped by two plugins (their folders differ). `once` counts per attach, so enabling a plugin again starts it over.

**What is not loaded is said, never dropped.** A path that leaves the plugin folder (`..`, an absolute path, a link that points out) is refused and named; a listed file that does not exist, is not a regular file, is over 1 MiB or is not JSON is named; an event this kernel does not have, a kind of hook it does not have and an entry it cannot read are named, as a problem on an event that can guard something and a note elsewhere. One bad event or entry never stops the others. An unreadable setting (`timeout`, `if`, `once`, a group's `matcher`) is left off and the hook runs, for more calls and never fewer. The problems are said at launch, listed by `/hooks` (`Not loaded: plugin <name>, <file>: ...`), reported by the `runtime.hooks` row of `namzu doctor`, and checked by [`namzu plugin validate`](../cli/plugin-validate.md), which names each one with the codes `hook-entries-outside`, `hook-entries-missing`, `hook-entries-unreadable`, `hook-entries-json`, `hook-entries-shape`, `hook-entries-invalid` and `hook-entries-note`.

**The switches stop them.** A plugin's entries are commands that run by themselves, which is what `disableHooks` and `NAMZU_DISABLE_HOOKS` are for: with either on, the entries of every plugin are read and listed (as `off`) and none is attached. `hooksManagedOnly` attaches only the managed file's hooks, and no plugin comes from the managed file (there is no managed place for plugins), so under it a plugin's entries do not run either. The plugin's JavaScript hooks are not touched by any of these and keep today's behaviour: plugins have their own on and off.

**Trust.** A plugin in the project folder (`.namzu/plugins/`) is read only after the folder is trusted: before the answer nothing in it is read or run (`namzu exec` refuses with exit 77, and the terminal asks first), and the terminal's trust prompt lists the entries the project's plugins would run, each with the plugin's name, as it lists the config files' hooks. `namzu doctor` in a folder that is not trusted says that plugins there are not read and what they ship is not counted. A user plugin and a folder named with `--plugin-dir` are the person's own choice and need no trust. The Desktop app's trust dialog lists them too, from [the one answer](#what-runs-by-itself-here-one-answer-for-a-program) (each entry named `the plugin <name>`).

**In the SDK.** `PluginManifest.hookEntries` holds the inline events object (as written; the host reads it), `isHookEntriesPath` tells a `.json` path from a module, and `PluginLifecycleManagerConfig.hooksFor` is how a host supplies the hooks it read for a plugin: it is called when the plugin is enabled, the definitions it returns are registered under the plugin's id and so are removed with the plugin's other hooks, and `listHooks()` marks them `shell: true`. `ShellHookOptions.plugin` (`{ root, dataDir }`) is what makes a command's folders; `substitutePluginFolders` and `isPluginFolderVariable` are the helpers. The reader of entries belongs to the host: the command line's is `readPluginHookEntries` in its config reader.

### Hooks in a skill

A skill whose `SKILL.md` front matter carries a `hooks` key runs under its own hooks for as long as it is in use: a skill written to check every command it runs, or to format every file it writes, keeps that check.

```yaml
---
name: careful-shell
description: Runs shell commands under a guard
allowed-tools: Bash
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: node
          args: ["${NAMZU_SKILL_ROOT}/guard.mjs"]
---
```

- **Either shape, read the way a config file's is.** The block is read by the same reader as the `hooks` key of a config file (see [A hooks block in the common shape](#a-hooks-block-in-the-common-shape)), so both shapes, both spellings of an event, every option and every problem read the same. The front matter reader holds the block as text and a real YAML reader takes it from there; no other key is read differently.
- **A hook event written at the top level is read too.** `PreToolUse:` and its list written beside `name:` instead of under `hooks:` (either spelling of the event) is read as if it had been written under `hooks:`, so a guard put in the wrong place is attached, not skipped as an unknown key. An agent file written that way is refused (its front matter reader refuses a block list it does not read), so move the entry under `hooks:` in both.
- **They attach when the skill is used,** not when skills are listed: when the model loads it with the `skill` tool, or the person runs it by name (`/skills <name>`, `/<name>`, `--skills <name>`, or `/<name>` as the prompt of `namzu exec`). They attach once the skill's instructions have been delivered, as its `allowed-tools` pre-approval is committed. Using the skill again does not attach them twice; a skill edited meanwhile replaces what it attached. Calls the model writes in the same message as the skill were checked before the skill ran: the `pre_tool_use` hooks of a whole message are asked before any call of it starts, so a skill's `pre_tool_use` guard does not see them, and the skill's result tells the model to make the calls it wants guarded in a later message. The `skill` tool is an ordering boundary in a message (the calls before it finish first, the calls after it wait), so a skill's later events (`post_tool_use`, `turn_end`) do cover the calls written after it. A skill's `session_start` entry is set aside with a note (the conversation has already started when a skill is used, so it could never fire), is not listed as attached and is not counted in the trust prompt.
- **They last as long as the conversation.** `/clear`, a resume, a fork, a rewind and leaving take them off; the conversation that follows starts without them (the skill's result says so: `until it is cleared or resumed`; a resumed conversation shows the old result, so load the skill again). Like config hooks they fire in the delegated agents the conversation starts. An entry with `once: true` is taken off after its first run that was not an error (a run that exits with an error code still counts as a run, as for `once` in a config file), and a `once` entry that no call has selected yet stays.
- **Events the host fires for the conversation.** An entry on `worktree_create` or `worktree_remove` is set aside with a note (it takes over how worktrees are made for the whole conversation, see [Worktrees](#worktrees)); an entry on `file_changed` or `cwd_changed` works for an inline skill (its matcher's files are watched while the skill is in use) and is set aside for a forked one, whose hooks cover its agent's run only.
- **A skill that sets `context: fork` attaches its hooks to the delegated agent's run only.** They cover no session until the agent starts, then the agent the skill delegated to (the one given the skill's prompt, even when the model started other agents in the same message and they started first) and the agents it starts, not the conversation that used the skill and not another agent; they end when the agent ends (a foreground agent: when the skill's call returns; a background one: when the agent stops).
- **What a hook from a skill receives** is what a config hook receives, plus `NAMZU_SKILL_ROOT`, the skill's own folder, in the environment; `${NAMZU_SKILL_ROOT}` in `command` and in each of `args` is replaced by it, so `args: ["${NAMZU_SKILL_ROOT}/guard.mjs"]` runs the script beside the `SKILL.md`. The rule by the shape of a name (see [Hook entries a plugin ships](#hook-entries-a-plugin-ships)) serves a skill too: a variable the command or its arguments refer to that is not set and whose name ends in `_PLUGIN_ROOT` or `_SKILL_ROOT` is given the skill's folder under the name the command used (a skill moved as written names its folder that way), and `_PROJECT_DIR` is given the project folder as for every entry; `_PLUGIN_DATA` is not given to a skill, which has no data folder, so it stays unset and the failure line names it. `/hooks` names an entry's `source` as `skill <name>`.
- **A guard that cannot be loaded is not a skill that runs unguarded.** If an entry on a guarding event (the events that can refuse or feed back into a call or a turn: `user_prompt_submit`, `pre_tool_use`, `post_tool_use`, `post_tool_use_failure`, `permission_request`, `pre_compact`, `turn_end`, `subagent_start`, `subagent_stop`) cannot be loaded, the skill still loads without its tool grants: the tools its `allowed-tools` lists are not pre-approved. The hooks that could be read are still attached (a good guard on `pre_tool_use` is not thrown away because an unrelated entry on `post_tool_use` was misspelled); only a block with nothing that could be read attaches nothing. The model is told in the skill's result and the person in one line, naming the entry and why. The skill loads with none of its hooks and none of its grants for a `hooks` block that is not YAML or not a mapping, one with more than 32 entries, one with an entry whose `matcher` or `if` is longer than 256 characters, and one longer than 32768 characters. An entry on any other event that cannot be loaded is dropped with a note, as is an event this kernel does not have (the note is in the skill's result and said to the person); the rest of the skill's hooks attach. A session that cannot run a skill's hooks (no hook runtime) treats a skill that carries them the same way.
- **A person can see them and switch them off.** `/hooks` lists the hooks skills have attached with the skill's name and how long they last, and says of a skill that carries hooks and has not been used that they attach when it is used. `disableHooks`, `NAMZU_DISABLE_HOOKS=1` and `hooksManagedOnly` stop them: the skill then loads as if it had no `hooks` key, and its tool grants stay, since the person chose to switch hooks off. No place of skills is managed by an organisation, so under `hooksManagedOnly` no skill's hooks run. `namzu doctor` (`runtime.hooks`) names the skills that carry hooks and warns, naming each, about one whose guard cannot be loaded, and `namzu skills --audit` and `namzu plugin validate` (`skill-hooks-problem`) report the same problems by name.
- **Trust.** A skill in the project folder (`.namzu/skills`, `.agents/skills`, `skills`) can run commands by itself once it is used, so the terminal's trust prompt lists the hooks the folder's skills carry beside the hooks its config files declare (`pre_tool_use (skill pguard): node ${NAMZU_SKILL_ROOT}/guard.mjs`). No session exists before the folder is trusted, so none of a project skill's hooks can attach before; a headless run attaches them under the same decision that lets it read the folder (trusted, or `--trust` for the run), and as a second check a project skill's hooks refuse to attach, and its tool grants are withheld, while the folder is not trusted. The Desktop app's trust dialog lists them too, from [the one answer](#what-runs-by-itself-here-one-answer-for-a-program) (`the skill <name> (when it is used)`).
- **In the SDK.** `SkillMetadata.hooksSource` is the block as written (with any hook event written at the top level moved under it by `skillHooksSource`; `SKILL_FRONTMATTER_HOOK_EVENT_KEYS` lists the spellings read that way, `executionBarrier: true` on the `skill` tool orders a batch, and `SkillHooksOptions.prompt` carries a forked skill's delegated prompt). The kernel does not read it: `SkillRegistryRef.prepareHooks` is how the `skill` tool asks the host that runs hooks what to do (what to tell the model, whether to withhold the `allowed-tools` pre-approval, and `attach`, which makes the hooks live once the instructions are delivered and returns a handle that removes them). A registry without it loads a skill that carries hooks without its pre-approval and says so. `PluginLifecycleManager.attachHooks(pluginId, hooks)` attaches hooks and returns a `HookAttachment` that removes exactly those (`remove`, `removeAt`); before it, hooks left only by plugin id. `ShellHookOptions.skillRoot` is the folder the rule above gives a skill's hooks. `ShellHookOptions.extraEnv` adds variables to every command of an adapter (never replacing the kernel's own), and `onRun` is called when a hook was selected to run.

### Hooks in an agent file

An agent file (the definitions delegated agents are started from: `~/.namzu/agents/<name>.md`, `<project>/.namzu/agents/<name>.md` and a plugin's `agents`) may carry a `hooks` key in its front matter. The hooks apply to each run of that agent and to nothing else.

```yaml
---
name: careful-runner
description: Runs commands under a guard and is checked before it finishes
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: node /opt/guards/shell-guard.mjs
  Stop:
    - hooks:
        - type: command
          command: node /opt/guards/before-finish.mjs
---
```

- **Either shape, read the way a config file's is.** It is the same reader as for a skill and for the `hooks` key of a config file, so both shapes, both spellings of an event, every option and every problem read the same. The front matter reader holds the block as text (`AgentFileDefinition.hooksSource`); `hooks` joins `AGENT_FILE_KEYS`.
- **They attach when a run starts and come off when it ends,** however it ends: done, failed, stopped or abandoned. They are attached to the child's own session, never to the agent's name, so two runs of one agent at the same time each have their own and ending one leaves the other's in place. They are attached before the child's `subagent_start` fires, so an entry on it fires for the run it belongs to. A run that is continued later (`send_message` to a finished agent) attaches them again.
- **Events the host fires for the conversation are set aside.** An entry on `file_changed`, `cwd_changed`, `worktree_create` or `worktree_remove` (like one on `session_start`, `session_end` or `turn_failure`) is set aside with a note and never attached: the host fires them for the conversation it runs, never inside an agent's run. A delegated agent that works in a worktree a `worktree_create` hook made still gets its file's hooks, attached to its own session, and they come off when it ends.
- **They fire for the run's own events only:** its tool calls and its turns. Not the delegating conversation's, not a sibling's. **Not an agent that agent starts either:** a guard in one agent file does not follow the agent into the agents it starts; each agent's file is its own. Whether an agent may start agents at all is decided by its tools (`tools`, `disallowedTools`), not by its hooks.
- **The end of an agent.** In an agent file an entry on `turn_end` (`Stop`) means "when this agent is about to finish", and it fires where `subagent_stop` fires for that run: after the run's own `turn_end`, with what `subagent_stop` carries (`agent_type`, `parent_session_id`, `parent_turn_id`, `stop_hook_active` and `last_assistant_message`), and it can keep the agent working in the same way (`exit 2`, or `{"decision": "block", "reason": "..."}`; the reason is given to the agent as a message). An entry written for `subagent_stop` fires there too. A command written under both runs once. A `matcher` on a `turn_end` entry is dropped (that event has none to test, and the agent's name could not fail to match the agent it came from). An entry on `session_start`, `session_end` or `turn_failure` is set aside with a note: the host fires those for the main conversation only. The refusals of a hook on the end of an agent are counted with every other (`maxHookRefusals`).
- **A guard that cannot be loaded is an agent that is not offered.** An entry on a guarding event (the same list as for a skill) that cannot be loaded, a block that is not YAML or not a mapping, one with more than 32 entries, an entry whose `matcher` or `if` is longer than 256 characters, or a block longer than 32768 characters keeps the agent out of the roster. The `Agent` tool does not offer it (its description lists it as not available); a call that names it is refused with one line that names the file and the entry (`Agent "careful-runner" is not offered: ~/.namzu/agents/careful-runner.md, hooks: PreToolUse group 1, hook 1 ...`); the line is also logged at launch, listed by `/hooks` and `namzu doctor`, and reported by `namzu plugin validate` (`agent-hooks-problem`, an error). An agent has no half state like a skill's "loads without grants": an agent that runs without the guard its file wrote has already done what the guard was there to stop. A file in the project folder that carries a guard is not offered either while the folder is not trusted (a terminal asks first; a headless run needs trust or `--trust`). An entry on any other event that cannot be loaded is dropped with a note and the agent is offered.
- **The host decides whether they can attach.** A session with no hook runtime, or a host that creates the sub-agent runtime without an `agentHooks` host, refuses to start an agent that carries a guard rather than start it unguarded; one that carries only other hooks starts with a note.
- **A person can see them and switch them off.** `/hooks` lists the hooks a live run has attached, with the agent's name and the run, and names agent files that carry hooks that attach to each run. `disableHooks`, `NAMZU_DISABLE_HOOKS=1` and `hooksManagedOnly` stop them (no agent place is managed): the agent is then offered as if its file had no `hooks` key, and runs without them, which is the person's own choice. `namzu doctor` (`runtime.hooks`) names the agent files that carry hooks and warns about each one that is not offered.
- **Trust.** The terminal's trust prompt lists the hooks the folder's agent files carry beside the config's own (`pre_tool_use (agent careful-runner): node ...`; an entry on `Stop` is named for where it fires, `subagent_stop`), and none of them can attach before the folder is trusted. The Desktop app's trust dialog lists them too, from [the one answer](#what-runs-by-itself-here-one-answer-for-a-program) (`the agent file <name> (when it runs)`).
- **The main conversation.** No command-line flag starts the main conversation as an agent definition (`--agent` belongs to `namzu learn`), so there is nothing to attach for it; an agent file's hooks reach only the runs it is started for.
- **What a hook from an agent file receives** is what a config hook receives. The payload of a tool event inside a child does not yet carry `agent_type`; the `source` shown by `/hooks` is `agent <name>`.

### Switches

- `disableHooks: true` (in the user file, or in the managed file) or `NAMZU_DISABLE_HOOKS=1` (for one run; `0` and `false` leave it as the files say) turns off every hook that comes from the user, project and local files, profiles in them included, and the hook entries plugins ship. Hooks of the organisation-managed file keep running. A `disableHooks` in a project or local file (or a profile declared there) is ignored, with a note at launch: a repository cannot switch off the hooks you set up. Once the user file, the environment or the managed file says `true`, no later file turns it back off. **The JavaScript hooks of plugins are not touched**: plugins have their own on and off (`plugins.enabled`, `/plugins`); see [Hook entries a plugin ships](#hook-entries-a-plugin-ships) for the entries they ship. The hooks of skills and of agent files obey both switches; see [Hooks in a skill](#hooks-in-a-skill) and [Hooks in an agent file](#hooks-in-an-agent-file).
- `hooksManagedOnly: true`, in the organisation-managed file only, attaches only that file's hooks: entries from the user, project and local files are not attached, and neither are the hook entries plugins ship (no plugin comes from the managed file). A user, project or local file that sets it is ignored, and the launch says so once.
- While either is in force, `/hooks` says so in its first line, and `namzu doctor` has a `runtime.hooks` row that counts the shell hooks attached per file, says whether a switch is on, and warns, naming each, about a `matcher` or `if` that cannot be read and about a hook a file declared that could not be loaded (see [A hooks block in the common shape](#a-hooks-block-in-the-common-shape)). A project's hooks that are declared but not attached because the folder is not trusted are reported there as not attached.

### `/hooks`

`/hooks` lists every hook attached, by event, each with the file it came from and its matcher, `if`, `once`, deadline, background and `onFailure` options, the names a command entry's `env` sets, and on a tool event which tool names it receives (`Namzu's own (bash)` or `as written (Bash)`) (and, under a hook whose `matcher` is not a regular expression that compiles or whose `if` is not `Tool(pattern)`, a line saying it cannot be read and what that means); then what the files declared that could not be loaded or was not acted on (`Not loaded:` for a hook that would have guarded something, `Note:` otherwise), then the hook entries enabled plugins ship, apart from their JavaScript hooks (`pre_tool_use · plugin review-bot · ${NAMZU_PLUGIN_ROOT}/guard.sh · matches Bash`, with `off (disableHooks)` when a switch left it off), and what a plugin's files declared that could not be loaded (`Not loaded: plugin review-bot, hooks/hooks.json: ...`), then the JavaScript hooks plugins registered, as the event and the plugin's name (`pre_tool_use · plugin review-bot`), then the hooks skills have attached (`pre_tool_use: node guard.mjs · matches Bash · skill careful-shell, for this conversation`) and the skills that carry hooks they attach when used, then the hooks live agent runs have attached (`pre_tool_use: node guard.mjs · matches Bash · agent careful-runner, run 01a1d3a1`), the agent files that carry hooks and the agent files that are not offered. A plugin that is disabled registers none of either. `/plugins` shows how many hook entries a plugin ships, enabled or not.

### What runs by itself here: one answer for a program

`/hooks`, `namzu doctor` and the trust prompt each say, in their own words, what runs by itself in a folder. A program (the Desktop app, a script) reads the facts instead, from one function: `describeFolderHooks` in the command line (`packages/cli/src/config/hooks-report.ts`). It reads through the readers a session uses (the config reader with its layers and switches, the plugin entry reader, and the skill and agent file hook readers) and returns data, not text. Two doors lead to it:

- `namzu hooks [--cwd <path>] [--json]` prints it for a person, grouped by where each hook comes from, or with `--json` as one JSON value on standard output.
- `namzu/hooks/list`, a method of the desktop host (`namzu acp --desktop`), answers it for the host's folder. It takes no parameters (a request that carries any is refused) and is the optional group `hooksView` of the [desktop contract](kernel-facts.md#the-desktop-contract). A host that is older than this change does not list `namzu/hooks/list` among the extensions it answers `initialize` with, and an application that asks the question only when the host lists it shows no hooks view for that host.

**Nothing of the folder is executed or imported.** The answer is made from reading files as text: the config files, a plugin's manifest and its files of entries, a skill's `SKILL.md` front matter and an agent file's. A plugin's JavaScript module is named (`modules`) and never loaded. So the question is safe to ask about a folder nobody has trusted. For such a folder the answer says `folder.trusted: false`, lists what the folder's own files, plugins, skills and agent files would start as `not-loaded` with the reason `folder-not-trusted` (none of it is counted as running), and `counts.waitingForTrust` says how many that is. What your own files, the managed file and your user plugins run is listed as it runs.

**The shape.** The answer carries `version` (1; the shape grows by adding fields, never by removing or renaming one, and a reader ignores the ones it does not know), `folder` (`path`, `trusted`), `switches`, `hooks`, `modules`, `problems`, `counts` and, when the configuration could not be read at all, `error` (what could still be read is listed).

- A **hook** row has a stable `id`, its `event` as this kernel names it and `eventWritten` where the event has a second spelling (`pre_tool_use` and `PreToolUse`), its `matcher` and `condition` (the `if`), its `type` (`command`, `http` or `prompt`), what it starts as `runs` (the command with its arguments, `POST <address>` with no query or credentials, or the first line of a prompt; never an `env` value or a header), its `origin` (`kind` `config`, `plugin`, `skill` or `agent`; the `label` a person reads; the `name`; the `path`; the `scope`, which for a config file is `user`, `project`, `local`, `profile` or `managed`), its `state` and `why`, its options (`once`, `async`, `timeoutMs`, `onFailure`) and `notes` the reader made about that one entry (a matcher or `if` that cannot be read and so fires for every call; a `file_changed` matcher that names no file).
- The `state` is `runs` (it fires on its event now), `off` (a switch or a setting leaves it out), `attaches-when-used` (a skill's or an agent file's hook, attached while it is in use) or `not-loaded` (it cannot run now). `why` is `{ code, text }`. The codes: `disableHooks` and `hooksManagedOnly` (the switch that turned it off), `plugins-disabled` (`plugins.enabled` is not on), `plugin-disabled` (the plugin is switched off), `skill-disabled` (named in `skills.disabled`), `folder-not-trusted` and `agent-not-offered` (an agent file whose guard could not be loaded is not offered). A reader treats a code it does not know as an unexplained `off` or `not-loaded`, and shows `text`.
- The **switches** report `disableHooks`, `hooksManagedOnly` and `plugins` as `{ on, setBy }`, where `setBy` says where the setting was made (`kind` `default`, `user-file`, `project-file`, `local-file`, `profile`, `env` or `managed`, with `path`, `variable` or `profile` as fits), and `limiting`, the one now limiting hooks (`managed-only` outranks `disabled`), absent when none is. An entry a switch holds back is still listed, as `off`, so a person sees what the switch is holding back; a plugin's JavaScript modules are not touched by either switch, and the answer says so by leaving them `runs`.
- The **problems** are what the readers reported, with the same severities as everywhere (`problem` for a hook that would have guarded something and could not be loaded, `note` for anything else), each with its `origin`, the `event` as the source spells it or the `file` inside a plugin, and `inactive: folder-not-trusted` when the source is not read as running yet. A project or local file that sets `disableHooks: true` gets a `note` with `event: disableHooks` saying the setting is ignored there, because a repository cannot switch off the hooks you set up. When the configuration cannot be read at all, one `problem` named `configuration` says so and `error` repeats it; that problem has no `scope`, so an application that lists what a folder would start must show it whatever the folder's trust, since no hook of a configuration the kernel cannot read is listed.

A hook the readers could not read has no row, only a problem: nothing is invented for it, and a guard that could not be loaded is never shown as running.

```json
{
  "version": 1,
  "folder": { "path": "/work/app", "trusted": false },
  "switches": {
    "disableHooks": { "on": false },
    "hooksManagedOnly": { "on": false },
    "plugins": { "on": true, "setBy": { "kind": "user-file", "path": "~/.namzu/config.yaml" } }
  },
  "hooks": [
    {
      "id": "3f9c1a7b2d40",
      "event": "pre_tool_use",
      "eventWritten": "PreToolUse",
      "matcher": "Bash",
      "type": "command",
      "runs": "./bin/guard.sh",
      "origin": { "kind": "config", "label": "/work/app/namzu.config.json", "path": "/work/app/namzu.config.json", "scope": "project" },
      "state": "not-loaded",
      "why": { "code": "folder-not-trusted", "text": "This folder is not trusted. It starts once the folder is trusted." }
    }
  ],
  "modules": [],
  "problems": [],
  "counts": { "runs": 0, "off": 0, "attachesWhenUsed": 0, "notLoaded": 1, "waitingForTrust": 1, "problems": 0 }
}
```

**The Desktop app reads it.** **Settings ▸ Tools** shows the answer for the project in front (for your own settings when no project is open): the hooks grouped by when they run, each with what it starts, where it comes from, where to change it, its state and the engine's reason when it is off or not loaded, and the problems the readers reported with the event or source they belong to; it is read-only. One switch, **Run hooks**, is the user-level `disableHooks` setting turned the other way round (turning it on puts the default back); it cannot be changed, and says why in one line, while the managed file or the environment decides (`switches.disableHooks.setBy` is `managed`, `env` or a profile, or `hooksManagedOnly` is on). The app's folder trust dialog asks for the answer of a folder that is not a project yet with `namzu hooks --cwd <folder> --json` (a short process, so no host is started in a folder nobody trusted), lists every hook the folder's files, plugins, skills and agent files carry, each named with its source, and keeps its own reading of the config file only as the fallback for an engine that does not know the question, saying in one line that the list may be incomplete. Neither screen starts a hook, and neither shows an `env` value or a header: the answer carries none, and the app removes credentials and queries from a line again. See [Desktop application](../cli/desktop.md#hooks-in-settings-and-the-trust-dialog).

The terminal's `/hooks` still shows the live session (the hooks skills and agent runs have attached right now), the doctor row still counts and warns, and the trust prompt still lists the folder's files as raw text before anything is applied; the plugin part of the doctor row reads plugins through the same function the answer does.

## Files and folders, and variables for later commands

Both events are fired by the host. The command line fires them; an embedder fires them through `FileChangeHooks` and `QueryParams.onWorkingDirectoryChange`.

### `file_changed`

A shell hook receives `file_path` (absolute) and `change`: `add` (the file did not exist and does now), `unlink` (it did and does not) or `change`. The common-shape name is `FileChanged`.

- **What is watched.** The paths named in the matchers of the hooks on this event (a list separated by `|` or `,`; a relative path is under the working folder; a part with a `*` names no file), plus the paths a hook hands back with `hookSpecificOutput.watchPaths`. The matchers count whoever attached the hook: a config file, a plugin's entries (while the plugin is on), a skill's hooks (while the skill is in use; not a forked skill's) are watched alike and the watch ends when the hook is taken off; an agent file's `file_changed` entry is set aside with a note, because the host fires the event for the conversation and never inside an agent's run. A new list replaces the list hooks handed back before and the matcher paths stay; an empty list clears it. A `session_start` or `cwd_changed` hook may hand one back too. Nothing is watched, and no watcher exists, when no hook names a path.
- **The matcher** is tested against the file's base name, read as every matcher is (a list, a glob, a pattern; one that cannot be read fires). A part written as a path stands for its base name: `config/app.json` is `app.json`. To react to a handed-back path, make the matcher match its name (or use `*`).
- **Settling.** Every write only restarts a half-second timer, so a burst of writes is one event; a file written by the session's own tools fires like any other change. A hook's own writes are not news: while a hook run for a file is under way, and for the file as that run left it, a settle that finds nothing new fires nothing, so a hook that appends to the file it watches runs once for the change that started it, not again every half second. A change by anyone after the run ended, or a different change than the run left, fires as usual; a change made by someone else while the run was still going is taken as the run's own.
- **How.** The platform's own `fs.watch` on the folder that holds each file (so a save by rename is seen), with this page's settling on top; no dependency. Watches never keep the process alive.
- **A folder that does not exist yet.** A matcher naming `missing/deep.txt` is reported at start (`cannot be watched yet`) and watched once `missing` is made; a file made in it at once is seen as `add`.
- **Limits.** At most 64 files are watched; a longer list is cut to its first 64 and the cut is reported once. A watch that cannot start, or breaks, is reported once for its folder and the session goes on. A watch that failed for another reason than a missing folder is not retried until a new list is set. A `file_changed` hook whose matcher names no file (none, or only patterns with a `*`) watches nothing itself: `/hooks` and the `runtime.hooks` row of `namzu doctor` say so.
- **Answers.** `systemMessage` is shown to the person (in the terminal's transcript, or on stderr for `namzu exec`). `watchPaths` is read as above; it must be a list of strings under `hookSpecificOutput`, and anywhere else the answer is reported as unreadable. These hooks cannot refuse anything (exit `2` and `decision: "block"` are ignored) and add no context to the model.

### `cwd_changed`

The one live change of the working folder is the shell tool's: the folder a command ends in is where the next one starts, and the event fires once per real change (after a `cd`, or when the shell was put back at the working directory for leaving the allowed folders), never when the old and the new folder are the same (a link to the same folder is not a change). The hook runs in the new folder, `cwd` and `new_cwd` are the new one, and it is awaited before the command's result is returned, so what it sets is there for the next command. `/worktree` only prints a command, and adding a directory does not change the working folder, so neither fires it. A sub-agent's own shell folder does not fire it. The common-shape name is `CwdChanged`.

### Variables for later commands

A command hook on `session_start`, `cwd_changed` and `file_changed` is started with `NAMZU_ENV_FILE`, the path of a file kept for the session outside the project (in Namzu's private scratch folder, removed when the session closes). It appends lines of the form `export NAME=value`; the commands the shell tool runs afterwards start with those variables, and so do sub-agents' commands. The hook's own environment does not change, and what it appended counts even if it then failed. No other event gets the variable. The hook is started by one function that also applies the rule by the shape of a name (see [Options on an entry](#options-on-an-entry)): `NAMZU_ENV_FILE` is among the variables Namzu sets and an entry's `env` cannot replace it, and a command written for another tool that names `$SOMETOOL_ENV_FILE` is given the same file. The same holds for a hook a plugin ships, and for a skill's, on these events.

- **Which lines are read.** `export NAME=value` and `NAME=value`, read as data and never run. A value is a bare word, `'single quoted'` (literal) or `"double quoted"` (`\"`, `\\`, `\$` and `\``), joined together; `$NAME` and `${NAME}` are replaced by the value in the session's starting environment or set earlier, or by nothing. A line with `$(...)`, a backquote, `$((...))`, any other `${...}` form, shell punctuation outside quotes or a second word is not read, and is reported once.
- **Which line wins.** A later line for a name replaces an earlier one. When two hooks of one kind set the same name, the one that comes later in the configuration wins, however long each took: each hook has a file of its own, read in configuration order. There is no unset: set it empty. `session_start` is outranked by `cwd_changed`, which is outranked by `file_changed`.
- **A change of folder** clears what `cwd_changed` and `file_changed` hooks set (they described the folder left) and keeps what `session_start` hooks set; then the `cwd_changed` hooks run.
- **Bounds.** The first 64 KiB of a file is read; a value over 8 KiB, a name over 128 characters and a variable past the 128th are left out and reported.
- **Refused names**, reported once and never set: `NAMZU_*` (the kernel's own settings, including `NAMZU_HOME`); the dynamic loader's `LD_*`, `DYLD_*` and `GCONV_PATH`; the shell's start-up and prompt hooks (`BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS`, `PROMPT_COMMAND`, `PS4`, `IFS`, `CDPATH`, `BASH_FUNC_*`) and `SHELL`; the interpreters' injection variables (`NODE_OPTIONS`, `PYTHONSTARTUP`, `PYTHONPATH`, `PYTHONHOME`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`, `RUBYLIB`, `JAVA_TOOL_OPTIONS`, `LOCPATH`, `NLSPATH`, `HOSTALIASES`); the programs Git runs on its own (`GIT_EXEC_PATH`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_PROXY_COMMAND`, `GIT_EXTERNAL_DIFF`); the name `__proto__`, which a process environment cannot hold;  and where the account and Namzu keep state (`HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`). They would change what runs without being a program a command names, or where state lives. `PATH` is allowed: it is the point.
- **Where it applies.** A turn started in the terminal or by `namzu exec` carries the variables and fires `cwd_changed`, a `--continue` turn included. A turn that was interrupted and is picked up again by the resume pass (a parked review, a crashed turn) does not yet: its commands start without the variables hooks set, and a `cd` in it fires no `cwd_changed`.
- **Seeing it.** `/hooks` lists the names set (never the values) with the kind of hook that set each, and the files watched.

## Worktrees

The kernel makes and removes worktrees with its own Git logic: for a sub-agent that works in its own checkout (`workspace: "worktree"`), and for `namzu worktree create`, `namzu worktree fork` and `/worktree`. A person whose checkouts are not Git's (another version-control tool, a prepared checkout, a plain copy) takes that over with a hook on `worktree_create`, and on `worktree_remove` for the removing. The common-shape names are `WorktreeCreate` and `WorktreeRemove`. Both are read in both shapes, like every event.

### `worktree_create`

A shell hook receives `name` (the suggested name: for a sub-agent, its session id), `worktree_root` (the folder the kernel would have placed the worktree under) and `base_ref` (the commit or branch the kernel would have started from, when it has one), beside the usual `cwd` (the project folder) and `session_id`. The hook makes the folder and answers its path:

- the **last non-empty line** it prints, or
- `hookSpecificOutput.worktreePath` of a JSON answer (a JSON answer without it is a failure; a `worktreePath` at the top level is reported as misplaced).

The kernel uses that folder as the worktree and creates none itself. A relative path is placed under `worktree_root`. The folder must exist when the hook ends. If the output is longer than Namzu keeps (64 KiB), the last line cannot be trusted, so the creation fails; send progress to stderr and print only the path.

With **no hook on the event**, the kernel creates the worktree as it always did. With hooks on it, the kernel never falls back to its own creation: if a hook fails (a non-zero exit, a time-out, a refusal with exit `2`, `decision: "block"` or `continue: false`), or prints no path, or names a folder that does not exist, the creation fails with a line that names the hook and what it printed (the start and the end of long output). A sub-agent then does not start, and the line is shown to the person (in the transcript, or on stderr for `namzu exec`) as well as given to the model as the reason; `namzu worktree create` exits with it. If several hooks answer a path, the first in order is used and the person is told.

Outside a Git checkout the kernel cannot make a worktree at all. With a `worktree_create` hook present, `namzu worktree create` and a sub-agent's worktree work there: the folder stands for the repository and `base_ref` is not sent.

A worktree a hook made is the hook's. `namzu worktree list` does not show it, and the kernel never runs its own Git removal on it. When a sub-agent that used it ends, the kernel decides whether to keep it as it does for any checkout (a child that changed nothing is removed, one that changed something is kept), but it cannot ask Git whether the folder changed: it compares the folder with how it looked when the hook finished (names, sizes and times of everything in it, up to 20,000 entries), and anything else, a folder too large to compare, or a folder made by another process counts as changed and is kept, with a line to the person saying where.

### `worktree_remove`

A shell hook receives `worktree_path`. It does the removing, and the kernel then removes nothing: this holds for **every** worktree, a kernel-made one too, so a hook that runs for a Git checkout must also tidy Git's own record (`git worktree remove` and the branch), because the kernel's removal, which does that, is not run. It runs when the kernel disposes of a worktree: a sub-agent's checkout that ended unchanged, or one whose start failed. A worktree a person keeps (a child with changes, `namzu worktree create`) is never removed by Namzu and so never reaches the hook.

A hook that exits `0` has removed it, whatever it printed. A failure (a non-zero exit, a time-out, a refusal) is reported with the start and the end of what it printed, unless nothing is left at the path, in which case the removal counts as done. With **no hook** on the event: a kernel-made worktree is removed as it always was; a worktree a `worktree_create` hook made is left in place, and the person is told where it is.

### What does not apply

A hook on either event may be shipped by a plugin: it is read as one in a config file and takes over the worktree while the plugin is on (`namzu worktree` commands open the plugins to find it). A skill's or an agent file's entry on either event is set aside with a note: it takes over how worktrees are made for the whole conversation, and a skill or a run is attached only while it is in use. `disableHooks`, `NAMZU_DISABLE_HOOKS=1` and `hooksManagedOnly` stop plugin-shipped worktree hooks as they stop the others, `namzu worktree` included.

Neither event has a matcher: one is ignored (as on other events with no name to match), and so are `if`, `once` and `async`, because a hook that does the work cannot be filtered or skipped without the kernel acting in its place. The hook always runs, and `/hooks` says when one of those keys is set. A `prompt` entry cannot make or remove a worktree and fails with a line that says so; a `command` and an `http` hook are read alike (the HTTP body is the output). `onFailure` has no effect: a failure is always a failure.

A project's hooks, as for every command, run only once the folder is trusted: `namzu worktree create` in a folder nobody trusted uses the hooks of the user and the managed file only. When that folder's own `namzu.config.json` or `namzu.config.local.json` declares a `worktree_create` hook, the command refuses (exit 64, nothing created) and says to trust the folder first, because a worktree the hook was written to replace must not be made by Git in its place; a file that cannot be parsed counts when it names the event.

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
