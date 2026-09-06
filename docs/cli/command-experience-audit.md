---
type: Design
title: Command experience audit
description: Verified command behavior defects and a proposed interaction contract for the operator application.
resource: packages/cli/src/tui/slashCommands.ts
tags: [cli, tui, commands, ux]
status: draft
---

# Command experience audit

Namzu's command experience mixes operator actions, runtime diagnostics and
configuration changes. The highest-priority problems are incorrect behavior
and reporting, followed by inconsistent discovery and presentation.

This audit examines the command catalogue and downstream handlers at Namzu
commit `8a8de4ae`, on 2026-09-06. The catalogue has 32 discoverable CLI commands
plus three kernel commands after the CLI takes ownership of `/skills`.
Evidence includes source inspection, controlled calls to the built report
renderers, and a comparison with selected Codex source and terminal snapshots.
It does not claim that every command was exercised against live credentials,
providers or every operating system. Findings below remain open; the proposed
interfaces are not shipped command syntax.

## Behavior and reporting defects

### Model selection replaces unrelated preferences

`/model` opens provider selection. `handlePickerSubmit` constructs a new
preferences object with one provider and an empty active-subagent list, then
saves it before constructing the replacement session. Existing fallbacks,
subagent selections and capability-mismatch acceptance disappear; a failed
activation can still change the saved configuration.

Evidence: [picker submission](../../packages/cli/src/tui/App.tsx#L5494),
[preference fields](../../packages/cli/src/integrations/providers/preferences.ts#L64).

Change only the setting the operator selected. Preserve unrelated preferences,
validate activation before publishing the saved change, and distinguish the
current conversation from future defaults. Start with the current provider's
models and offer a separate action to change providers.

### Permission reporting does not cover all supported modes

The status renderer handles `auto` and `strict`, then describes other modes
as asking before unreviewed calls. Actual execution automatically approves
eligible edit batches in `accept-edits` and rejects changes in `plan`. The
invalid-argument help also lists only three of the five supported modes.

Evidence: [status renderer](../../packages/cli/src/tui/slashCommands.ts#L1394),
[usage message](../../packages/cli/src/tui/slashCommands.ts#L897),
[execution policy](../../packages/sdk/src/runtime/query/review-policy.ts#L185).

Derive menu labels, help and status descriptions from the same mode definition.
Show the effective behavior first. Keep rule precedence available as detail.

### The task command has no connection to the task store

The TUI advertises `/tasks`, but constructs its command registry without
`taskStore`. The handler consequently refuses every invocation, even though
the query runtime creates task stores and the activity area displays tasks.
Calling the built handler with the same supplied options reproduces the
refusal.

Evidence: [TUI dispatch](../../packages/cli/src/tui/App.tsx#L4852),
[task handler](../../packages/sdk/src/registry/command/kernel-commands.ts#L255),
[runtime store](../../packages/cli/src/tui/agent.ts#L1935).

Connect the command to the same run-owned task state. State which run is being
shown, and distinguish an empty task list from unavailable storage.

### Help and autocomplete have different command catalogues

App merges the kernel and CLI catalogues for execution and `/help`. Composer
calls `matchSlashCommands` without that merged catalogue, so matching defaults
to CLI-local commands. `/goal`, `/tasks` and `/agents` can execute and appear in
help, but are absent from slash autocomplete.

Evidence: [merged catalogue](../../packages/cli/src/tui/App.tsx#L2807),
[composer matching](../../packages/cli/src/tui/Composer.tsx#L386),
[default catalogue](../../packages/cli/src/tui/slashCommands.ts#L393).

Pass one live catalogue to discovery, completion and execution. Availability
should use the same state facts, with execution revalidating before mutation.

### Usage reports confuse scope and units

`/cost` says usage spans every turn and only grows. Normal sends allocate new
run IDs, and each usage event replaces the displayed totals. A smaller second
run can therefore reduce the displayed value. `/status` additionally prefixes
the first line of `renderCost` with `Spend`, producing `Spend: Tokens: 12,000`
in a controlled fixture.

Evidence: [usage update](../../packages/cli/src/tui/App.tsx#L3762),
[run allocation](../../packages/cli/src/tui/App.tsx#L3978),
[scope claim](../../packages/cli/src/tui/slashCommands.ts#L1184),
[status composition](../../packages/cli/src/tui/slashCommands.ts#L1379).

Label current/last-run usage honestly. Conversation totals require aggregation
across durable runs. Render token counts and monetary amounts from typed
fields, never by extracting a line from another formatted report. Retain the
distinction between unknown pricing and a measured zero.

## Interaction and content gaps

| Surface | Current problem | Proposed operator experience |
| --- | --- | --- |
| `/agents` | Lists configured IDs; the running-agent panel is reachable through Ctrl+T instead. | One panel with Running and Available views, recognizable names and state. |
| `/goal` | Inspection, arbitrary objective text and automatic continuation share one parser. With no existing goal, `/goal status` creates an objective named `status`. Reports use `armed`, `Rounds admitted` and blocker codes. | Show the objective, progress and clear Start/Edit/Pause/Resume/Remove actions. Explain automatic continuation and its allowance before starting it. |
| `/status`, `/cost`, `/context` | Facts compete with paragraphs explaining kernel implementation. A modest fixture produces 32 status lines and 20 permission lines. | Compact facts first; expanded explanations and diagnostics on request. |
| `/status config` | A values-free provenance report is the only configuration inspector. It cannot show the current value or edit it. | A settings surface for safe effective values, scope and supported changes; provenance remains a separate diagnostic view. Credentials remain excluded. |
| `/mcp` | Every connected server immediately prints every tool name. | Connection state and counts first; server details and tool inventory when selected. |
| Shared pickers | Labels use JavaScript string length and fixed width bounds. The current marker follows a description that can be truncated. Search and disabled-state explanations are absent from the common row model. | Keep selection markers visible, use terminal display width, stack descriptions on narrow screens and support search and unavailable reasons. |
| Picker navigation | Most surfaces use Esc to cancel, while previous-prompt editing uses Esc to move through history and `q` to leave. | Arrow keys navigate choices; Esc consistently returns to the parent or closes the surface. |

Evidence: [agent command](../../packages/sdk/src/registry/command/kernel-commands.ts#L314),
[goal parser and report](../../packages/sdk/src/registry/command/kernel-commands.ts#L60),
[report renderers](../../packages/cli/src/tui/slashCommands.ts#L1069),
[configuration diagnostic](../../packages/cli/src/config/debug.ts#L99),
[choice layout](../../packages/cli/src/tui/ChoicePicker.tsx#L22),
[previous-prompt keys](../../packages/cli/src/tui/App.tsx#L5581).

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
[Gemini command reference](https://geminicli.com/docs/reference/commands/) and
[settings interface](https://geminicli.com/docs/cli/settings/).

## Implementation order and acceptance

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

The kernel's extensibility is useful. The missing layer is a consistent
operator experience that expresses those capabilities without exposing every
internal boundary as command output.
