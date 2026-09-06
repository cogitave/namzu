---
type: Design
title: Command experience audit
description: Historical command audit at 8a8de4ae, implementation status and remaining operator-experience limits.
resource: packages/cli/src/tui/slashCommands.ts
tags: [cli, tui, commands, ux]
status: draft
---

# Command experience audit

The historical baseline mixed operator actions, runtime diagnostics and
configuration changes. The audit prioritized incorrect behavior and reporting,
then inconsistent discovery and presentation. The implementation status below
records the subsequent repairs without rewriting the original findings.

This audit examines the command catalogue and downstream handlers at Namzu
commit `8a8de4ae`, on 2026-09-06. The catalogue has 32 discoverable CLI commands
plus three kernel commands after the CLI takes ownership of `/skills`.
Evidence includes source inspection, controlled calls to the built report
renderers, and a comparison with selected Codex source and terminal snapshots.
It does not claim that every command was exercised against live credentials,
providers or every operating system. The findings and proposed interfaces in
the historical sections describe that commit, not the current source.
[Implementation status](#implementation-status) identifies what changed and
what remains limited. Current syntax is documented in
[Slash commands](slash-commands.md). This page does not assert an npm release.

## Historical behavior and reporting defects

### Model selection replaces unrelated preferences

`/model` opens provider selection. `handlePickerSubmit` constructs a new
preferences object with one provider and an empty active-subagent list, then
saves it before constructing the replacement session. Existing fallbacks,
subagent selections and capability-mismatch acceptance disappear; a failed
activation can still change the saved configuration.

Evidence: [picker submission](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/cli/src/tui/App.tsx#L5494),
[preference fields](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/cli/src/integrations/providers/preferences.ts#L64).

Change only the setting the operator selected. Preserve unrelated preferences,
validate activation before publishing the saved change, and distinguish the
current conversation from future defaults. Start with the current provider's
models and offer a separate action to change providers.

### Permission reporting does not cover all supported modes

The status renderer handles `auto` and `strict`, then describes other modes
as asking before unreviewed calls. Actual execution automatically approves
eligible edit batches in `accept-edits` and rejects changes in `plan`. The
invalid-argument help also lists only three of the five supported modes.

Evidence: [status renderer](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/cli/src/tui/slashCommands.ts#L1394),
[usage message](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/cli/src/tui/slashCommands.ts#L897),
[execution policy](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/sdk/src/runtime/query/review-policy.ts#L185).

Derive menu labels, help and status descriptions from the same mode definition.
Show the effective behavior first. Keep rule precedence available as detail.

### The task command has no connection to the task store

The TUI advertises `/tasks`, but constructs its command registry without
`taskStore`. The handler consequently refuses every invocation, even though
the query runtime creates task stores and the activity area displays tasks.
Calling the built handler with the same supplied options reproduces the
refusal.

Evidence: [TUI dispatch](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/cli/src/tui/App.tsx#L4852),
[task handler](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/sdk/src/registry/command/kernel-commands.ts#L255),
[runtime store](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/cli/src/tui/agent.ts#L1935).

Connect the command to the same run-owned task state. State which run is being
shown, and distinguish an empty task list from unavailable storage.

### Help and autocomplete have different command catalogues

App merges the kernel and CLI catalogues for execution and `/help`. Composer
calls `matchSlashCommands` without that merged catalogue, so matching defaults
to CLI-local commands. `/goal`, `/tasks` and `/agents` can execute and appear in
help, but are absent from slash autocomplete.

Evidence: [merged catalogue](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/cli/src/tui/App.tsx#L2807),
[composer matching](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/cli/src/tui/Composer.tsx#L386),
[default catalogue](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/cli/src/tui/slashCommands.ts#L393).

Pass one live catalogue to discovery, completion and execution. Availability
should use the same state facts, with execution revalidating before mutation.

### Usage reports confuse scope and units

`/cost` says usage spans every turn and only grows. Normal sends allocate new
run IDs, and each usage event replaces the displayed totals. A smaller second
run can therefore reduce the displayed value. `/status` additionally prefixes
the first line of `renderCost` with `Spend`, producing `Spend: Tokens: 12,000`
in a controlled fixture.

Evidence: [usage update](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/cli/src/tui/App.tsx#L3762),
[run allocation](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/cli/src/tui/App.tsx#L3978),
[scope claim](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/cli/src/tui/slashCommands.ts#L1184),
[status composition](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/cli/src/tui/slashCommands.ts#L1379).

Label current/last-run usage honestly. Conversation totals require aggregation
across durable runs. Render token counts and monetary amounts from typed
fields, never by extracting a line from another formatted report. Retain the
distinction between unknown pricing and a measured zero.

## Historical interaction and content gaps

| Surface | Problem at the audited commit | Proposed operator experience |
| --- | --- | --- |
| `/agents` | Lists configured IDs; the running-agent panel is reachable through Ctrl+T instead. | One panel with Running and Available views, recognizable names and state. |
| `/goal` | Inspection, arbitrary objective text and automatic continuation share one parser. With no existing goal, `/goal status` creates an objective named `status`. Reports use `armed`, `Rounds admitted` and blocker codes. | Show the objective, progress and clear Start/Edit/Pause/Resume/Remove actions. Explain automatic continuation and its allowance before starting it. |
| `/status`, `/cost`, `/context` | Facts compete with paragraphs explaining kernel implementation. A modest fixture produces 32 status lines and 20 permission lines. | Compact facts first; expanded explanations and diagnostics on request. |
| `/status config` | A values-free provenance report is the only configuration inspector. It cannot show the current value or edit it. | A settings surface for safe effective values, scope and supported changes; provenance remains a separate diagnostic view. Credentials remain excluded. |
| `/mcp` | Every connected server immediately prints every tool name. | Connection state and counts first; server details and tool inventory when selected. |
| Shared pickers | Labels use JavaScript string length and fixed width bounds. The current marker follows a description that can be truncated. Search and disabled-state explanations are absent from the common row model. | Keep selection markers visible, use terminal display width, stack descriptions on narrow screens and support search and unavailable reasons. |
| Picker navigation | Most surfaces use Esc to cancel, while previous-prompt editing uses Esc to move through history and `q` to leave. | Arrow keys navigate choices; Esc consistently returns to the parent or closes the surface. |

Evidence: [agent command](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/sdk/src/registry/command/kernel-commands.ts#L314),
[goal parser and report](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/sdk/src/registry/command/kernel-commands.ts#L60),
[report renderers](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/cli/src/tui/slashCommands.ts#L1069),
[configuration diagnostic](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/cli/src/config/debug.ts#L99),
[choice layout](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/cli/src/tui/ChoicePicker.tsx#L22),
[previous-prompt keys](https://github.com/cogitave/namzu/blob/8a8de4ae/packages/cli/src/tui/App.tsx#L5581).

## What the Codex source comparison establishes

The comparison pins `openai/codex` to
[`008bbd5884122dc95aaece19ecfe0fc6a59dcf36`](https://github.com/openai/codex/commit/008bbd5884122dc95aaece19ecfe0fc6a59dcf36).
These are concrete design examples, not a universal standard or a claim about
which models a current installation can access.

* Codex centralizes descriptions, argument support and command availability,
  with shared filtering for discovery. Namzu should connect its existing live
  catalogue to every entry point. [Command metadata](https://github.com/openai/codex/blob/008bbd5884122dc95aaece19ecfe0fc6a59dcf36/codex-rs/tui/src/slash_command.rs#L167),
  [discovery filtering](https://github.com/openai/codex/blob/008bbd5884122dc95aaece19ecfe0fc6a59dcf36/codex-rs/tui/src/bottom_pane/slash_commands.rs#L70).
* Selection rows distinguish current, default, disabled reason, search text and
  selected-row detail. Narrow layouts can put descriptions below labels and
  measure grapheme display width. [Selection state](https://github.com/openai/codex/blob/008bbd5884122dc95aaece19ecfe0fc6a59dcf36/codex-rs/tui/src/bottom_pane/list_selection_view.rs#L127),
  [responsive rows](https://github.com/openai/codex/blob/008bbd5884122dc95aaece19ecfe0fc6a59dcf36/codex-rs/tui/src/bottom_pane/selection_row_layout.rs#L14).
* The model picker builds effort choices from the selected model. Namzu already
  filters effort against usable providers; retain that correctness while
  making selection and application scope easier to understand.
  [Model and effort selection](https://github.com/openai/codex/blob/008bbd5884122dc95aaece19ecfe0fc6a59dcf36/codex-rs/tui/src/chatwidget/model_popups.rs#L439).
* MCP inspection offers a compact summary and a separate full inventory.
  Status presentation labels unavailable information instead of inventing a
  value. [MCP output](https://github.com/openai/codex/blob/008bbd5884122dc95aaece19ecfe0fc6a59dcf36/codex-rs/tui/src/history_cell/mcp.rs#L521),
  [status snapshot](https://github.com/openai/codex/blob/008bbd5884122dc95aaece19ecfe0fc6a59dcf36/codex-rs/tui/src/status/snapshots/codex_tui__status__tests__status_snapshot_shows_unavailable_limits_message.snap).
* Both applications already offer branch, uncommitted, commit and custom
  review targets. Namzu can improve branch/commit search and return navigation
  without inventing another review workflow. [Review pickers](https://github.com/openai/codex/blob/008bbd5884122dc95aaece19ecfe0fc6a59dcf36/codex-rs/tui/src/chatwidget/review_popups.rs#L5).

The same summary/detail and searchable-settings patterns also appear in the
[CLI command reference](https://geminicli.com/docs/reference/commands/) and
[settings interface](https://geminicli.com/docs/cli/settings/).

## Historical implementation order and acceptance

1. Repair preference preservation, permission reporting, task-store reachability,
   catalogue consistency and usage scope. Verify real state transitions, including
   failed model activation and a second run with lower usage.
2. Introduce a small shared selection-row contract and command availability
   metadata. Keep SDK data and enforcement authoritative; let the CLI own human
   labels, grouping and interaction. Exercise the same commands through both
   completion and help, including unavailable choices.
3. Replace report essays with summary, rows, optional detail and applicable
   actions. Keep scope and uncertainty explicit. Check wide and 40-column
   terminals, preserved drafts and consistent Esc behavior.

The audit identified a need for consistent operator workflows around the
kernel’s existing capabilities. The work below follows that direction.


## Implementation status

The current source implements the following contracts. This records code
behavior, not a claim that every platform, provider or release gate has been
validated.

| Area | Implemented behavior |
| --- | --- |
| Model changes | `/model` starts at the current provider’s models and offers a separate provider action. Selection preserves unrelated preferences and fallback models. Replacement construction precedes atomic preference persistence and activation; failures retain the old session. Temporary credentials keep selection local to the session. |
| Permissions | All five modes use a shared behavior description. Direct help includes every mode. `plan` and `accept-edits` reports match their execution behavior, and an old approve-all choice cannot override plan or strict reporting. Rule lists are available through `/permissions details`. |
| Tasks | `/tasks` reads the actual store supplied to the current/latest run, including resumed runs. Starting another run or switching conversations clears the selected readout. Empty, not-yet-available and unsupported lists are distinct; stored tasks are not deleted. |
| Discovery | Composer completion, `/help` and dispatch use the same merged command catalogue. Shared availability metadata can explain an unavailable action, and execution rechecks it. |
| Reports | `/status`, `/cost` and `/context` show summaries with explicit `details` variants. `/mcp tools` expands the server summary. Spend is rendered from monetary data; own-run cost, delegated tokens, estimated context and unknown prices remain distinct. |
| Settings | `/settings` shows safe effective model, effort and permission values and opens their existing controls. Configuration provenance remains a separate values-free report. |
| Goals | Bare `/goal` opens a menu; `status` is read-only and `set` explicitly creates an objective, either directly or through the editor. The menu exposes continuation controls and the automatic-turn allowance. Reports use enabled/paused continuation language. |
| Choice menus | Shared rows support current/default markers, terminal display width, narrow layouts, selected detail and unavailable reasons. Command, skill, branch and commit menus filter by typing, including digits. Esc returns or cancels rather than stepping through earlier prompts. |
| Agent activity | `/agents` and `/agents running` open the delegated-work view already available through Ctrl+T. `/agents available` reports the configured roster separately. |

## Remaining limits

* Running agents and configured agents remain separate views. The available
  roster is still a list of configured identifiers; it is not a combined,
  editable catalogue with role, model and capability details.
* Settings cover model, reasoning effort and permissions. They are not a
  general configuration editor, a credential manager or a UI for editing
  fallback chains. Permission and effort changes remain session-scoped;
  normal model choices are saved for future launches.
* Usage reports cover the current or latest run. Conversation-wide cost would
  require aggregation across durable runs, and descendant costs are not
  included in the displayed own-call cost.
* `/tasks` does not browse tasks from arbitrary historical runs. Changing the
  conversation or provider session can leave no current task selection until
  another run is admitted.
* Search is available in the shared command, skill, branch and commit menus;
  it is not yet a universal interaction across provider/model, conversation
  history and every specialized picker.
* The archive flow still archives the conversation and exits the application.
  A return-to-conversation-list archive workflow was not part of this repair.

See [Slash commands](slash-commands.md),
[Context and compaction](context-and-compaction.md) and
[Terminal design](terminal-design.md) for the current operator contracts.
