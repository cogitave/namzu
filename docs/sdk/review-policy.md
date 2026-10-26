---
type: Reference
title: The review policy
description: The seven modes a turn resolves tool review under (including bypass and the classifier-backed classify), which calls skip review, a tool's own unconditional requiresApproval declaration, asking once per session before the screen is shared, asking about one call at a time while the batch runs, and how a host supplies the person to ask.
resource: packages/sdk/src/runtime/query/review-policy.ts
tags: [sdk, hitl, permissions]
status: stable
generated: { by: process:claude-code, at: 2026-09-24T00:00:00Z }
---

# The review policy

An authorization rule says what a tool may do. A review policy resolves calls the gate routed to review, either because no rule covered them or because a matching rule requested review. Calls already allowed or denied by the gate never reach it, so a mode cannot reopen a denial.

# Build one

```ts
import { createReviewPolicy, ToolManager, type ToolReviewPrompt } from '@namzu/sdk'

const registry = new ToolManager({ toolsets: [], messages: () => [] })
const prompt: ToolReviewPrompt = async ({ toolCalls }) => {
  // Show the calls to the person; return what they decided.
  return toolCalls.length > 0 ? { kind: 'approve' } : { kind: 'reject', feedback: 'nothing to run' }
}

const policy = createReviewPolicy({ mode: 'accept-edits', prompt, registry })
```

`policy` is an `ApprovalPolicy` whose `name` is the mode, so a durable log can say which one approved a call. Swap it on a turn's `SessionApprovalPolicy` to change mode without ending the turn. `createReviewHandler` returns only the `ResumeHandler`.

The prompt receives the originating `turnId` alongside `toolCalls`. Hosts can use this exact identifier to attribute concurrent child reviews; tool names or arguments are not ownership evidence. The field is optional for custom prompt callers, but `createReviewHandler` always supplies it.

# The modes

| Mode | Calls routed to review |
| --- | --- |
| `prompt` | Ask the person. The default when a `prompt` is supplied. |
| `auto` | Approve. The default without one. |
| `accept-edits` | Approve a batch of `edit` and `write` calls (a `write` is always flagged destructive because its input cannot say whether the file exists, so for `write` the flag alone does not stop the mode; a path outside the roots, a protected file and a rule's ask still do), and shell lines that only run `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp` or `sed` on paths inside the roots (see below); ask when anything else rides along, because the batch is reviewed as a unit. |
| `plan` | Refuse every mutation with `PLAN_MODE_REFUSAL`, which tells the model to present its plan. A batch of reads that is here only for a path outside the roots is asked about instead, as in `prompt`. The kernel's `permissionMode: 'plan'` is the floor under this. |
| `strict` | Refuse with `STRICT_MODE_REFUSAL`: nothing runs unless a rule allowed it. |
| `bypass` | Run everything except the short list in [Bypass and classify](#bypass-and-classify). |
| `classify` | Let a classifier model decide what a person would otherwise be asked; the same short list still goes to a person. See [The auto-review classifier](auto-review.md). |

`accept-edits` approves those shell commands only when the host gives `ReviewPolicyOptions.roots` (the working directory first, then the added directories, or a function that reads them now) and the whole line passes the same path reading the kernel uses for escalations: every command is one of the seven (or a literal `cd`), no path is outside the roots, protected, or decided at runtime, no `rm` target is catastrophic, no program name is unknown, the line is read to its end, and any `sed` script is made only of substitutions and line commands (a script with the `e`, `w` or `r` commands, or one read from a file, is asked about). Without `roots` those commands are asked about, as before. `ACCEPT_EDITS_SHELL_COMMANDS` lists the seven.

A stricter mode than the rules, `plan` above all, cannot refuse what never reaches it: a batch a rule allows, or one a grant from earlier in the turn covers, runs without asking the handler. A host that can be in such a mode passes `reviewAllowedCalls: () => boolean` on `QueryParams`; the kernel asks it once per batch, and `true` sends the batch to the handler anyway, each call carrying the gate's decision in `authorization`. A rule's `deny` still refuses whatever it returns. `modeReviewsAllowedCalls(mode)` answers it for the SDK's own modes: `true` for `plan` and `classify`. The CLI answers `true` only while its live mode is one of those, so a mode entered mid-turn reaches the next batch.

The switch reaches delegated turns too. A child borrows its parent's handler, and without the switch a call covered by an approval given earlier in the CHILD's own turn skipped that handler after the parent had entered plan mode. `AgentTaskContext.reviewAllowedCalls` carries the parent's function to every child and grandchild: `AgentManager` stamps it onto the child config after the `configBuilder` runs (`BaseAgentConfig.reviewAllowedCalls`) and onto the child's own spawn context, `SupervisorAgent` hands its config's value to its workers, and `QueryAgent` (including `ReactiveAgent`) and `SupervisorAgent` pass it to their `query()`. It is the function, not a sampled answer, so a mode entered while a child runs reaches that child's next batch. A child config that sets its own value keeps it, OR-ed with the inherited one: a descendant can add review, never answer `false` over a parent that answers `true`. A host that builds its own `AgentTaskContext` for a `TaskScheduler` sets the field from the same function it passes its own `query()`.

A person's refusal reaches the model as the `feedback` of the answer when there is one. Without words of their own, every refused call reads `DECLINED_TOOL_CALL_FEEDBACK`: the user declined it, and the model must not get the same content or result another way (another tool, site or address, or a web search) unless it asks first and they agree. The same text is the default when a durable `reject_tools` decision or a `modify_tools` denial carries no feedback. It used to be "User declined to run the proposed tool(s).", after which a model whose browser navigation was refused fetched the same page through web search.

A refusal by a person is also recorded as theirs, so a host can show "declined" instead of "failed" after the conversation is reopened. The model-facing `feedback` cannot say who refused, because a policy refusal fills it too, so the answer carries a separate marker: `ToolReviewAnswer`'s `reject` takes `declined?: { note? }` (and `AcpPermissionOutcome`'s `reject` the same), `reject_tools` passes it on as `declined`, and a `modify_tools` denial of one call counts as the person's too. `note` is what the person said in their own words, without any wrapper a host put around it in `feedback`. Only a host that sets `declined` gets this: the strict, plan and unattended refusals, the gate's denials, a repeat refusal, and a rejection a host makes for its own reasons ("The approval screen closed.") are never marked. The executor then records, on the call's `tool_completed`, a generic result view `{ kind: 'generic', label, declined: { note? } }` whose `label` is the call's target (the file path, the command) and whose note is cut at 4,000 characters; the result text the model reads is unchanged.

`planModeWrite: (call: ToolCallSummary) => boolean` is how a host gives `plan` its one writable file. In `plan`, a call it accepts is neither refused nor asked about: it may sit outside the roots and overwrite a file that is there. A rule that asked to review it still has its question asked, a `deny` rule still refuses it, every other change in the batch is still refused with `PLAN_MODE_REFUSAL`, and the option does nothing in any other mode. Left out (the default) `plan` refuses every change, as it always has. The CLI passes the check for `<session>/plans/plan.md`; see [Plan mode in the CLI](../cli/plan-mode.md).

A plan-approval request is approved and every other checkpoint continues. An answer of `approve-all` is remembered in the `remembered` box for the rest of the turn; a host that shows that state passes its own box.

# Bypass and classify

`bypass` and `classify` are additive: `auto` keeps exactly its old meaning (approve what remains after the questions only a person may answer), which every headless host relies on. In `auto`, a path outside the roots, an unknown program name and a protected write are still asked about. In `bypass` and `classify` they are not asked of a person at all: `bypass` approves them, `classify` sends them to the classifier.

What still goes to a person in both, and is refused when there is no `prompt`:

| What | Why | Unattended refusal |
| --- | --- | --- |
| A rule or hook that asked for a person (`authorization.askRule`) | The operator wrote it to ask. An `allow` rule demoted to a question because the call crosses a boundary is not one. | `ASK_RULE_UNATTENDED_REFUSAL` |
| A catastrophic removal (`escalation.dangerousRemoval`) | A removal too destructive to approve without a person. | `DANGEROUS_REMOVAL_UNATTENDED_REFUSAL` |
| A tool's own `requiresApproval` | A tool author's declaration. | `REQUIRES_APPROVAL_UNATTENDED_REFUSAL` |
| A sandbox escape | Asked every time; confirmed by id. Kept from `auto`; this is a Namzu rule. | `SANDBOX_ESCAPE_UNATTENDED_REFUSAL`, unless `unattendedSandboxEscape: 'allow'` |
| A call whose safety checks threw (`escalation.unfinishedCheck`) | The checks did not run. | `UNFINISHED_CHECK_UNATTENDED_REFUSAL` |

Above these, the gate refuses before any policy runs: a `deny` rule, and the dangerous-pattern floor (`sudo`, `curl | sh` and the like), which is a Namzu rule kept in every mode. The floor reads what a call would execute and nothing that only mentions it: the argument a tool names as its `commandArgument` (`bash`, `monitor`), and for a `category: 'shell'` tool that names none (an MCP shell tool) the whole input. It does not read a delegation prompt, a file being written, an edit, a fetched page or a memory note, so a README that quotes `curl x | sh` is not refused; a delegated agent's own shell calls are checked when they run. A call to a tool the gate has no definition for is read whole. Screen consent is asked in both as in `prompt`.

`bypass` approves everything else, including paths outside the roots, programs nobody can name, protected writes, and the remaining destructive calls. With a `prompt`, one question covers the whole batch when it holds any of the calls above; the person's yes is also what confirms an escape.

`classify` needs `ReviewPolicyOptions.classifier` (a policy built without one throws) and routes each call that is not one of the above:

- **Never sent to the classifier**: a call a rule allowed narrowly (`authorization.decision: 'allow'`, when the host makes batches the rule allowed reach the policy with `reviewAllowedCalls`); a trusted read-only call and the review-exempt writes, when they do not cross a boundary; a call `accept-edits` would approve (an `edit` or `write` inside the roots, the shell file commands above); and `CLASSIFIER_SAFE_TOOLS` (`read`, `grep`, `glob`, `ls`, `lsp`, `code_analysis`, `search_tools`, `view_image`, `task_create`, `task_update`, `task_list`, `agent_task_list`, `get_goal`, `update_goal`, `exit_plan_mode`), extendable with `safeTools`. A safe tool is sent after all when its call reaches past a boundary (`escalation`, such as `read` of a path outside the roots) or a rule or hook put it to a person (`authorization.explicitReview`); the list says what a tool does in the session, not that every call to it is harmless.
- **A rule's allow is not consulted** when it is too wide for the classifier to defer to: a rule covering a whole shell tool (`authorization.allowScope: 'tool'`), a command line that starts an interpreter or launcher, matched on the program's base name so `/usr/bin/python3` counts (`python*`, `pypy*`, `node`, `deno`, `tsx`, `ruby`, `perl`, `php`, `lua`, `npx`, `bunx`, `uvx`, `pipx`, `bash`, `sh`, `zsh`, `fish`, `pwsh`, `powershell`, `cmd`, `busybox`, `ssh`, `eval`, `exec`, `env`, `xargs`, `sudo`, `make`, `awk`, `find -exec`, `git -c`, `uv run`, `poetry run`, `cargo run`, `go run`, and the package managers' script verbs: `npm run`, `test`, `start`, `exec`, `x`, `create`, and for `pnpm`, `yarn` and `bun` any verb that is not one of their own commands, so `pnpm build` and `bun app.ts` count). Option arguments are skipped when the verb is found, so `pnpm -C packages/sdk run build` and `npm --prefix . exec foo` count too, a line the reader cannot finish, or a delegation tool (`Agent`, `create_task`, `continue_task`). Such a call is judged on its content, and a host must answer `reviewAllowedCalls` with `modeReviewsAllowedCalls(mode)` for the batches to arrive.
- **Sent**: everything else, in order, one call at a time. A block refuses the whole batch with the words in [The auto-review classifier](auto-review.md#what-the-model-is-told); the remaining calls are not judged. Calls that were gate-denied are left out of everything.

The handler reads the conversation from the second argument a turn gives every `ResumeHandler`, `ResumeContext.transcript()`, never from the request, so a transcript is not written to the session log with a parked review. A host that wraps the handler must pass the context on.

# Which calls skip review

`isReviewExempt(registry, name, input)` says yes for a tool that declares itself read-only and is trusted to say so (`isTrustedReadOnly`, the authorization gate's own predicate) and for the bookkeeping writes in `REVIEW_EXEMPT_WRITES`: `task_create`, `task_update`, `update_goal`. It says no for a `network` tool even when read-only, because the request leaves the machine to an address the model chose, and for a tool the registry does not know. `batchNeedsReview` is the batch rule: any explicit review request, destructive call, `requiresApproval` call or non-exempt call means the batch is reviewed.

The built-in `job` classifies each prepared action: reading/listing owned output
is exempt by default; stopping work is not. `DefineToolOptions.readOnly` supports
typed input predicates for other mixed-purpose host tools.

A `custom_pattern`, `argument_pattern` or `by_source` authorization rule can explicitly
return `review` (see [Rules that ask](#rules-that-ask)). Matching
calls retain `authorization.explicitReview: true` in `ToolCallSummary`, including
durable review requests. That marker prevents read-only and accept-edits
exemptions from silently resolving the request. The selected review policy still
decides: prompt modes ask, strict/plan refuse, and auto or remembered approval
can approve. Existing scoped tool grants remain prior approval; a deny rule still
outranks them. Custom hosts providing their own handlers own those decisions.

# Rules that ask

`argument_pattern` takes `decision: 'review'` as well as `allow` and `deny`. A matching call goes to the review policy, marked `explicitReview`, instead of being decided by the gate:

```ts
import type { AuthorizationRule } from '@namzu/sdk'

const askBeforePush: AuthorizationRule = {
  type: 'argument_pattern',
  toolNames: ['bash'],
  argument: 'command',
  pattern: '^git push',
  decision: 'review',
}
```

A `review` rule matches the way a `deny` does. The whole value is tested, then every segment of it read as a command line, and any match counts. So the rule also asks about `true; git push`. An `allow` still needs every segment to match and nothing hidden in the line. Rules are first-match, so a `deny` before a `review` still refuses. The reason reads ``sent for review because the `command` argument matched …``. A `custom_pattern` rule with `decision: 'review'` now reads `sent for review by a pattern rule …`; it used to read `allowed by …`.

A tool whose input schema canonicalises an argument to a URL declares it with `ToolDefinition.urlArgument` (`defineTool({ urlArgument })`). A rule on that argument tests the value whole, never as a command line. Without the declaration, `&`, `;` and `|` in a query string cut the value into segments, and an `allow` for a site declined every address with a query string. The `browser` tool declares `url`. See [Browser tools](browser-tools.md#one-spelling-per-address).

`by_source` decides from the owning toolset's host-assigned source id. For example, `{ type: 'by_source', sources: ['mcp:github'], decision: 'review' }` asks about every tool from that MCP server, including its prompts and resource tools. Any id or glob in `sources` may match. `*` matches any characters, including `/`, so `plugin:acme/mcp:*` covers plugin-owned MCP servers. The source is supplied by `ToolManager.sourceOf`; a tool's input or self-declared metadata cannot set it. If a caller has no source to supply, the rule does not match. Rules still run in order, before the default read-only allowance.

# Calls a skill pre-approved

A skill loaded earlier in the turn can pre-approve calls through its `allowed-tools`. The review phase marks each covered call with `ToolCallSummary.skillGrant = { skill }`, but only when no deny, explicit ask, destructive flag or escalation applies to it. `createReviewHandler` approves a batch without asking when every call it would have asked about carries the mark, and reports those ids in `approve_tools.skillGranted` so the kernel can record each approval in the audit trail under the skill's name. `plan` and `strict` refuse before that check, so a skill never outranks them. `skillGrants: 'ignore'` turns the check off. See [Skills and allowed-tools](skills.md).

# The first look at the screen

`screenConsent: { sessions: Set<string> }` asks once per session before the model first sees the screen. A call captures the screen when `capturesScreen(name, input)` says so — by default the tool's own `ToolDefinition.capturesScreen` declaration read from `registry` (`defineTool({ capturesScreen })`); `computer_use` declares its screenshots, zooms, window lists, UI snapshots and every action that returns a screenshot afterwards. The first batch in a session holding such a call, and not allowed or denied by a rule, is put to `prompt` with `ToolReviewRequest.screenConsent: true` in `prompt`, `accept-edits` and `plan`, even when every call only reads. A yes adds the session id to `sessions` and answers that batch too; a no refuses it with `SCREEN_CONSENT_DECLINED_FEEDBACK`. `strict` refuses the call unless a rule allowed it, `auto` never asks, and without a `prompt` the batch is refused with `SCREEN_CONSENT_UNATTENDED_REFUSAL`. A host keeps one record across mode switches and turns; a new session id is asked again. Without the option the screen is treated like any other read. So that the first capture reaches the policy at all, the gate's `allow_read_only` rule (`allowReadOnlyTools`) does not allow a call that declares `capturesScreen`: it falls through to review, where the policy asks once or, without a consent record, approves it as the read it is. A custom `ResumeHandler` therefore now sees such calls. An explicit rule for the tool (`allow_by_name`, `permissions: { computer_use: 'allow' }`) still allows them without asking. See [The computer_use tool](computer-actions.md#sharing-the-screen-asked-once-per-session).

# Asking one call at a time

By default a model response is one batch: the policy sees every call together, one `tool_review` request names them all, and nothing runs until the whole answer is back. `perCallReview` (a query option, and `BaseAgentConfig.perCallReview`) turns that into a walk over the calls in the model's order, and is off unless set. A host that does not set it sees the same requests as before.

```ts
import { createReviewPolicy, type PerCallReviewConfig } from '@namzu/sdk'

const listeners = new Set<() => void>()

const perCallReview: PerCallReviewConfig = {
  // Told when the host's rules or mode change; every question still open is re-checked.
  onRulesChanged: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  // Whether the host's current rules and mode now let this call run without asking.
  covers: (call) => call.name === 'read',
  // A call whose exact input was not shown in full is never approved by a re-check.
  neverCover: (call) => call.input === undefined,
}

const policy = createReviewPolicy({
  mode: 'prompt',
  prompt: async ({ toolCalls, signal }) => {
    // `signal` aborts when the question stops being open: show nothing more, ignore the answer.
    return signal?.aborted ? { kind: 'reject' } : { kind: 'approve' }
  },
})
```

Pass `perCallReview` to `query()` (or the agent config) together with `policy.handler` as the `resumeHandler`.

**How a batch is walked.** Calls that are safe to run side by side (the tool's `isConcurrencySafe`) start together, and each opens its own one-call request at once, in the order the model wrote the calls whatever each call's own checks take. A call that waited for its turn is checked against the rules, the grants and `covers` as they are then, before it is asked: a rule remembered by an earlier answer covers a later identical call, which runs without being shown and is audited as approved without being shown. A call that is not safe waits until every earlier call has finished, then asks, then runs, and nothing after it starts before it does. An approved call starts right after its answer. A call the gate allowed, or a grant from earlier in the turn covers, is not asked and starts at its place in the walk. Every request in this mode has `toolCalls` of length one and `perCall: true`, and each opens its own `tool_review_requested` and `tool_review_completed` events.

**Refusing.** A refusal with the person's reason (`reject` with `declined` and `feedback`, no `endTurn`) refuses that call only; the others carry on and the model reads the reason. A refusal with `endTurn: true` (`ToolReviewAnswer`'s `reject`, `reject_tools` as a decision) ends the turn: every call of the batch is answered first. A call that is running is cancelled, a call that has not started is refused without being asked, and the questions still open are closed through their `signal`. The results are announced in the model's order: the refused call first, then the calls that were refused without being asked. The turn then stops with the stop reason `cancelled`, as an interrupt does, and the model is not called again. A host that continues a goal after a turn ends treats it as an interrupt, not a finished round. `endTurn` is also honoured on a batch reviewed as a unit.

**Answers the walk does not accept.** An approval is explicit. A `modify_tools` answer that does not name the call with `approve` refuses it, and a `modify` of the input is refused (editing a call while it is asked about is not offered). `approve_plan`, `reject_plan` and `answer_question` are not answers to a tool question and refuse the call. `pause` refuses that call and ends its park as superseded, so it is not held (the model is told to ask again); to hold a question for another process, review the batch as a unit. An `abort`, or the turn's own cancellation, ends the walk like a refusal with `endTurn`. A call that has no reviewed summary and did not fail preparation is refused.

**Re-checks.** When `onRulesChanged` fires, and after an approval that remembers a grant, each question still open is checked against the turn's rules, the grants and `covers`, after the host's `neverCover` has had its say. A call they now cover is let through without being shown: its request's `signal` aborts, its park is recorded as approved, and the audit trail says the call was approved without being shown. A re-check only ever approves. A call that reaches past the turn's boundary, that its tool says always needs a person, or that a rule or hook asked a person about is never approved by one, and while `reviewAllowedCalls` answers `true` (a mode stricter than the rules) the rules and grants do not count. `neverCover(call)` is asked first and overrides every other way a re-check could approve: answer `true` for a call whose exact input was not shown in full or was too large to show, and it stays open however a rule, a grant or `covers` changes (a `neverCover` that throws counts as `true`).

**Questions about the whole batch.** `askTogether` names calls (by id) whose question is about the batch and not about one call, such as the first look at the screen. They are asked in one request before anything starts. A yes approves them without a second question each; a No refuses them all.

**Workflow and delegated agents.** The option applies to the turn it is set on. A delegated child reviews its own batches as it did before; a host that wants its prompts behind the main session's decides that where it shows them.

**A person's words.** A typed reason is capped and stripped of control characters before it is shown or recorded, and is written to the audit trail as `declined by the person: <reason>`. A gate denial is never recorded that way.

# Escalated calls

A call carrying `ToolCallSummary.escalation` — a path outside the turn's roots, a request to leave the sandbox, or a command whose own program name is decided at runtime — is always reviewed: `batchNeedsReview` is true for it and `accept-edits` does not approve it alone. A path outside the roots is asked about in every mode that does not refuse it, `auto` and a remembered `approve-all` included, and refused with `OUTSIDE_ROOTS_UNATTENDED_REFUSAL` when there is no `prompt`. A sandbox escape is asked about in every mode that does not refuse it, `auto` and a remembered `approve-all` included, and approved only with its id in `confirmedEscalations`; with no `prompt` it is refused with `SANDBOX_ESCAPE_UNATTENDED_REFUSAL` unless `unattendedSandboxEscape: 'allow'`. An unknown program name is asked about the same way `outsidePaths` is (a plain `approve` is enough) and refused with `UNKNOWN_PROGRAM_UNATTENDED_REFUSAL` when there is no `prompt`; there is no unattended opt-in for it. See [Crossing the tool boundary](escalations.md).

`unattendedSandboxEscape: 'allow'` confirms only the sandbox escape. If the same call or batch also crosses an outside-root path, declares `requiresApproval`, or has an unknown program, an unattended run refuses the whole batch with that boundary's refusal reason.

# A call the tool itself declares always needs approval

`ToolDefinition.requiresApproval(input)` (`defineTool({ requiresApproval })`) is a tool author's own declaration that this exact call needs a person's approval, independent of destructiveness and of how the host configured its rules. It exists for a call that is sensitive for a reason other than being destructive — it costs money, it leaves an audit trail somewhere else, it is policy-sensitive — so an author stops having to misdeclare `isDestructive` on a call that does not destroy anything just to get a review the host might not otherwise configure.

**How it differs from `isDestructive`, plainly**: `isDestructive` is real, but it is not unconditional. A gate `allow` rule (`allow_by_name`, `allow_by_category`, an `argument_pattern` matching the call, …) still lets a destructive call straight through — the rule outranks it — and so does `auto` mode or an unattended turn once the batch clears the gate: nothing in `batchNeedsReview`'s `isDestructive` check stops the `mode === 'auto' || !prompt || remembered.all` catch-all from approving it. A host that assumed `isDestructive` alone was an unconditional "always ask a human" guarantee never had one.

`requiresApproval` is that unconditional guarantee, wired the same way `escalation` (a sandbox escape, a path outside the turn's roots) already is, not the way `isDestructive` is:

- **Survives a gate `allow` rule.** `runToolReview` forces the gate's decision back to `review` for a `requiresApproval` call the same way it already does for an escalated one — before the `allAllowed` shortcut can settle the batch without ever reaching a person. A `deny` rule is untouched: this can only ADD a review, never remove one a rule closed.
- **Asked about in every mode that reaches it** — `prompt`, `accept-edits`, `auto` (with a `prompt` present) — in its own unconditional branch in `createReviewHandler`, ahead of the `mode === 'auto' || !prompt || remembered.all` catch-all that a destructive call can fall through. A remembered `approve-all` does not silence it: the latch was an answer given about ordinary calls, before this one's requirement existed.
- **Refused, not silently approved, when nobody can be asked** — `auto` or any mode with no `prompt` — with `REQUIRES_APPROVAL_UNATTENDED_REFUSAL`.
- **Refused outright under `strict`**, like everything `strict` does not have an explicit rule for, without ever reaching the ask.
- **Refused under `plan`** when the call would mutate, like any other change; a call that only reads is asked about rather than silently approved as the read it is (the read-only/`accept-edits` exemptions do not cover it either).
- **No grant, skill grant or `accept-edits` exemption covers it.** A skill's `allowed-tools`, a remembered `ToolGrantSet` entry, and `accept-edits`'s `edit`/`write` fast path all decline to approve it on their own — the kernel never even marks such a call `skillGrant`, and the accept-edits and toolGrants shortcuts each check the flag before taking effect.

Never populated from a connected server's own MCP annotations (`mcpToolToToolDefinition` does not set it, whatever the server's `_meta` claims): a server cannot demand, or waive, its own review requirement. It is host/plugin-trust-boundary metadata, like `capturesScreen`.
