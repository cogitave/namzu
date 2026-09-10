---
type: Reference
title: Terminal design
description: Namzu's visual identity, reading order and interaction boundaries in the terminal.
resource: packages/cli/src/tui/App.tsx
tags: [cli, tui, design, accessibility]
status: stable
---

# Terminal design

Namzu uses neutral text with phosphor-green accents on the terminal's own
background. A two-row block-letter wordmark carries the opening identity, with a muted
version beside it. Terminals narrower than 48 columns or shorter than 20 rows
use the compact `∴ namzu` signature. The header is printed once
into native scrollback. The footer alone shows the current model, reasoning
effort and working directory, with interaction keys taking priority on narrow
screens. Provider and tool details remain available through `/status` and
`/status tools`. A normal startup does not add a redundant connection message
to the conversation; explicit provider/model changes still receive confirmation.
Switching models does not repeat the project-instructions notice when the loaded
file list is unchanged. A newly loaded non-empty list is announced; instruction
loading itself still runs for the replacement session.
The composer owns the empty-conversation typing hint. Colors use
explicit ANSI 256-color indices so the green accent and neutral text do not
shift hue through RGB-to-palette approximation. Terminals with color disabled
retain the same text, symbols and boundaries.

## Compact tool activity

Successful built-in file reads, searches and file discovery share an `Explored` heading when consecutive. Each operation keeps its own row and retained output; `Ctrl+O` expands the output, and errors remain explicit ungrouped failures. The CLI `tool-end` event includes optional `output` containing retained tool text before preview formatting; the built-in event adapter supplies it. Background job reads and stops identify the action and job instead of displaying JSON arguments. Reading job output is not an interactive terminal wait or a write to stdin; those operations are not provided by the current job tool.

Model discovery (`agent_models`) shows a compact catalogue: model name and
provider, exact ID, published context size and effort menu. At most five entries
appear, with an explicit remaining count. Empty results and unavailable catalogues
are distinct. Ctrl+O expands the original retained JSON; malformed receipts and
tool failures keep the ordinary output view. This is a TUI projection only and
does not change the model-facing tool result.

## Reading the conversation

The `›` mark identifies an operator message and `∴` identifies a Namzu reply.
Tool results remain grouped beneath their calls, with expandable output and
diffs. Color supports the text and symbols: errors, permissions and task states
retain explicit labels. Raw output remains the original source projection.

Tool output retains every line admitted by the runtime, including long first
lines and diagnostics beyond line 200. For more than six lines, the default
preview shows the first three and last three, with an omission count between
them. This keeps final diagnostics visible without joining nonadjacent lines
silently. Each visible line is shortened to 240 characters, and Ctrl+O is
advertised whenever text is hidden. Ctrl+O opens the retained body; `/raw` also
includes it. Runtime output limits still apply: a retained artifact path
identifies output beyond those limits. Neither action re-executes the tool.

File-discovery calls name both the glob pattern and its directory. A shallow
`*` search is visibly distinct from recursive `**/*`; result and traversal
limits add an explicit incomplete-search notice. See
[Bounded file discovery](../sdk/file-discovery.md).

A square message frame marks the writing area. Green corners and the `MESSAGE`
label identify the active input; its long edges stay quiet. The two frame rows
take the place of vertical padding, so the frame adds no height to the previous
input layout. The frame stays static while working. Opening a permission prompt
or text/command picker hides it while keeping the composer mounted, so drafts
and attachments survive the transition.

The Working indicator uses the Namzu wordmark with a repeating green fill and
pale leading edge, alongside elapsed time. This is activity, not percentage
progress. Short or narrow screens use the compact signature. Animation stops
for permission and text prompts and disappears when work ends; no success is
inferred from a stopped turn. Decorative motion is disabled for non-interactive
output, screen readers, `NO_COLOR`, `FORCE_COLOR=0` and `TERM=dumb`.
Animation ticks update only the live activity region, leaving the input and
transcript components alone.
Elapsed time, bounded progress text and task status carry the details. Agent
panels use the same quiet rules and highlight the current selection with the
accent color.

When the full previews would crowd the input area, activity shows the current
tool and total tool count; the plan shows the current step and completion
counts. The full lists return when space allows. These panels also reserve
space before the transcript keeps any older messages in its redrawable tail.

## Commands and settings

Successful reasoning changes receive a short session-scoped confirmation;
resetting the selection names the provider default. Configuration warnings,
instruction-file disclosure, unavailable tools and startup errors remain visible.

A model change requested in conversation shows a compact call row with the
target model. Successful receipt text stays out of the transcript display;
the full pending receipt remains in conversation history. A successful solitary
call ends the turn directly, without a model-generated acknowledgement.
The footer keeps showing the active model while the turn and its persistence
finish. Only a successfully prepared and applied replacement updates the
footer and receives a model-change confirmation. Cancellation or preparation
failure retains the previous session. These conversational changes preserve
history and affect only the current session; see
[Settings and model changes](slash-commands.md#settings-and-model-changes).
Running delegated agents or background jobs prevent replacement, preserving
their active session until that work ends.

The CLI leaves deferred-tool discovery to the kernel. `search_tools` is offered
when the registered roster contains deferred tools; a session whose tools are
all active does not advertise an empty search capability.

The writing area, `/help` and command execution share one catalogue. Commands
with state-dependent availability explain why an action cannot run; execution
checks again before changing state. Opening a menu keeps the draft and its
attachments mounted beneath the overlay.

The common choice row separates the label, current/default markers,
description and unavailable reason. It measures terminal display width rather
than JavaScript string length. Narrow screens put the description beneath the
label and reduce the visible page to leave room for navigation. The selected
row can show additional detail without hiding its current marker.

Command, settings, goal, skill, branch and commit menus accept text filtering.
Digits belong to the search query in these menus. Arrow keys navigate and
Enter applies an available selection; non-searchable menus keep their numeric
shortcuts. Esc returns to the parent or cancels, including the earlier-prompt
picker. The footer describes the keys used by the active surface.

Text editors for conversation names and goals keep a single visible input row.
Long values scroll with the cursor, including after terminal resizing, so the
editor title and save/cancel keys remain visible. Omission marks affect only the
display; editing and saving preserve the complete value and Unicode characters.

Permission choices use plain labels: Ask before changes, Auto-approve edits and
Plan (read-only). More options holds automatic tool approval, preapproved-only
execution and the rule report. Both levels identify the effective current
behavior and session scope. Settings use named controls and the same effective
permission value. Internal mode identifiers remain accepted as typed shortcuts.
The approval prompt spells out when a choice allows all tools for the session.
Agent launch reviews lead with the task, type and built-in tool capabilities,
including the default general-purpose type when omitted. A prompt saying
"only inspect" does not change the displayed tool authority. Role and optional
workflow/phase labels precede the full instructions, which remain pageable
alongside exact JSON. Agent-only reviews use explicit start/do-not-start actions;
the separate session-wide choice still says it allows all tools.

`/status`, `/cost`, `/context` and `/mcp` lead with short factual summaries.
Explicit details show configuration rules, pricing scope, cleanup counters or
tool inventories. A missing measurement is labelled as missing; token totals,
context occupancy and monetary cost are distinct quantities. Cost refers to
the current or latest run, not an accumulated conversation total.

`/settings` shows the current model, effort and approval mode with links to
their controls and configuration-source diagnostics. It excludes credentials
and does not edit arbitrary configuration keys. Model selection starts with
the current provider. A visible `p change provider` action above the model list
names other detected providers that Namzu can construct from available
credentials. The list states whether selection affects future launches or only
a session using a temporary credential. The old session remains usable if
replacement construction or preference persistence fails.

`/goal` presents objective management and automatic continuation controls,
including the automatic-turn allowance before work starts. `/tasks` reads the
current or latest run’s own task store; changing conversations clears the
selection without deleting tasks. `/agents` opens the retained delegated-work
view, while `/agents available` separately reports the configured roster.

The delegated-work view first separates workflows. Independently launched work
in another parent run appears as a separate workflow, including when names are
reused. Within a run, explicit workflow labels group phases across tool batches;
unlabelled batches remain separate workflows. Repeated batches in the same
explicit phase do not create new phases. These annotations describe grouping,
not execution dependencies or barriers.

With multiple workflows, the workflow picker opens first. Selecting a workflow
shows only its phases and agents; Esc returns to workflows and `q` or Ctrl+T
returns to the conversation. Older completed or cancelled work stays available.
Pending admissions show `Queued` until the child run starts. Completed Agent
and `wait_for_task` outputs name the actual `task_id` and terminal status before
the child result, so identifiers inside that result remain clearly separate.

The delegated-work view separates phases and agents with a column divider on
wide terminals and stacked panes on narrow terminals. Task labels, status and
elapsed time occupy separate cells; activity text does not repeat the status.

Selecting an agent opens its own framed transcript screen. The parent composer
and live rows are hidden while their state remains mounted. The child view
uses the available terminal height, identifies the task and its live status,
and supports line and page scrolling. File-output tabs are expanded before
pagination, and wrapping uses terminal cell widths for Unicode graphemes. Each
body row stays within its frame, with room for navigation and the cursor. Esc returns to the agent list; `q` or
Ctrl+T returns to the main conversation and restores the draft. A child that
finishes remains readable in the open view and can be reopened from `/agents`
while retained by the current session. The automatic activity rail shows only
cohorts with work still running.

Messages submitted with Enter while an `Agent` call waits for a child release
that wait so the parent can respond while children continue. Results arrive in
the same run as task notifications. Tab still queues a future turn; Esc still
interrupts the current run and its children.

## Terminal boundaries

The interface uses the normal terminal buffer so completed output remains in
native scrollback. Its transcript owner remains mounted through startup and
provider pickers, with the live rows hidden while a picker owns the screen.
Only the current work is redrawn. Changing terminal width
keeps the selected agent and the input draft, while model/path text yields to
the keys needed to leave a prompt. The palette targets dark backgrounds; the
application does not paint a full-screen background or depend on color alone.

When the terminal contracts, native reflow can push old live rows into
scrollback before the renderer can erase them. Namzu clears and reconstructs
its normal-buffer transcript once at the new size, preserving conversation
messages, the draft and the selected agent. This costs one history replay per
contraction; ordinary streaming and animation frames remain incremental.

Screen regressions drive the production Ink renderer through a terminal
emulator. They check wrapped input, short viewports, retained drafts, normal
scrollback and the amount of output emitted during streaming. These checks use
controlled session events and require no model calls.

When a run stops for budget, iteration, policy or validation reasons, a short
reason notice stays beside any retained partial output. Normal completion and
operator cancellation do not add a redundant stop notice. The composer remains
usable for a follow-up; a token allowance refusal does not claim every reserved
token was spent.

When startup cannot load its state or construct a session, a `Startup stopped`
notice replaces the writing area. The detailed error remains in scrollback;
Esc or one Ctrl+C closes the application so the operator can repair the named
file and restart. A startup refusal does not create an unscoped session or
silently replace an installation identity.

## Paste and response boundaries

The composer enables terminal bracketed paste while it owns input. A paste split
across terminal input chunks is assembled before editing the draft; pasted
newlines do not submit it. Windows CRLF and CR line endings become LF. Large or
multiline text has a `Pasted text #N · N chars` chip; the count uses Unicode code
points, including emoji as one code point. Short single-line pastes insert at
the cursor. Terminals without bracketed-paste support retain chunk-based fallback
handling, which cannot reconstruct a paste boundary the terminal does not send.

Separate provider message IDs create separate assistant transcript entries,
including completion follow-ups inside one parent run. Pending text is flushed
at that boundary so the last status sentence cannot merge with the next answer.


The agent browser owns its viewport rather than sharing it with an inactive
composer. Its navigation stays at the bottom and list capacity grows with the
terminal height. Returning to the main conversation restores its draft.

## File write presentation

A write approval shows the proposed complete body, labelled as a possible
replacement rather than a confirmed new-file diff. Its line count excludes a
final line terminator while preserving real blank lines. On completion the
SDK receipt supplies Created, Updated, Unchanged or Wrote (unknown prior state),
UTF-8 byte count and, when available, the changed-region preview. The diff label
is independent of the path. Final-newline-only changes are explicitly named.
This display change does not grant permission to overwrite a file.

## Task continuity in the CLI prompt

The CLI identity describes Namzu as an agent kernel with a TypeScript SDK and
the CLI as one interface. Completed prior-turn tool actions remain usable
evidence; the identity does not require a fresh action just to report earlier
work. It still forbids invented actions and distinguishes current execution
from history. An unavailable capability blocks dependent work, not unrelated
parts that can still be completed. Shared coding guidance uses proportional
verification and defers concurrency guarantees to runtime metadata.


Ctrl+O does not reprint an old result into scrollback. When an expansion cannot
fit the live region, a bounded output viewer owns that region instead. It
paginates physical rows, preserves retained text, and supports left/right output
navigation. Closing it restores the composer draft. Incoming approvals close the
viewer so permission input stays reachable. This changes only presentation, not
model history or tool execution. Existing static scrollback is not erased.

Screen regressions use the existing `@xterm/headless` emulator with production
Ink rendering to exercise repeated opening/closing, pagination and scrollback
counts. It interprets emitted terminal control sequences; it does not replace
Ink's component layout or require a browser terminal in the CLI.

## Upgrade activity

`namzu upgrade` animates a green fill through the existing wordmark while npm
installs the selected version. This is an activity loop, not a percentage.
The wordmark remains fully green only after the installed version is read back
and matches the requested version. Failures clear the animation and show npm
diagnostics (the last 16,384 characters) followed by the error.

The animation uses stderr only in an interactive text terminal. `--check`,
quiet mode, structured output, `NO_COLOR`, dumb terminals, and redirected stderr
keep static output. Terminals below 28 columns use the compact signature; below
12 columns the animation is disabled. The renderer releases its timer and exit
listener when the operation finishes, and clears its display on process exit.
