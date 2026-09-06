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
background. The compact `[ NAMZU ]` wordmark sits above the workspace and
connection identity; narrow terminals use the plain `NAMZU` name.
The header is printed once into native scrollback; the footer keeps
the current model, reasoning effort and interaction keys visible. Colors use
explicit ANSI 256-color indices so the green accent and neutral text do not
shift hue through RGB-to-palette approximation. Terminals with color disabled
retain the same text, symbols and boundaries.

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
input layout. While a turn is working, a short green light travels clockwise
around the border and fades behind its leading edge. The message text and
label stay steady. The light follows the actual frame dimensions, including
multiline drafts and terminal resizing, without adding rows or moving input.
Opening a permission prompt or text/command picker hides the
frame while keeping the composer mounted, so its draft and attachments survive
the transition. The light stops while input belongs to another surface and
when the turn ends. It is disabled for non-interactive output, screen readers,
`NO_COLOR`, `FORCE_COLOR=0` and `TERM=dumb`.
Existing submit, queue, steering and history keys keep their behavior.

The Working indicator and the border light share the renderer's animation
scheduler. Border ticks update only the decorative overlay, leaving the input
and transcript components alone. Reply marks and tool rows remain steady.
Elapsed time, bounded progress text and task status carry the details. Agent
panels use the same quiet rules and highlight the current selection with the
accent color.

When the full previews would crowd the input area, activity shows the current
tool and total tool count; the plan shows the current step and completion
counts. The full lists return when space allows. These panels also reserve
space before the transcript keeps any older messages in its redrawable tail.

## Commands and settings

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

## Terminal boundaries

The interface uses the normal terminal buffer so completed output remains in
native scrollback. Its transcript owner remains mounted through startup and
provider pickers, with the live rows hidden while a picker owns the screen.
Only the current work is redrawn. Changing terminal width
keeps the selected agent and the input draft, while model/path text yields to
the keys needed to leave a prompt. The palette targets dark backgrounds; the
application does not paint a full-screen background or depend on color alone.

Terminal reflow can leave an earlier activity snapshot in native scrollback
after a window is narrowed and enlarged. Those rows are inactive output;
the live task state is not duplicated. Namzu keeps finalized history rather
than clearing scrollback to erase those snapshots.

Screen regressions drive the production Ink renderer through a terminal
emulator. They check wrapped input, short viewports, retained drafts, normal
scrollback and the amount of output emitted during streaming. These checks use
controlled session events and require no model calls.

When startup cannot load its state or construct a session, a `Startup stopped`
notice replaces the writing area. The detailed error remains in scrollback;
Esc or one Ctrl+C closes the application so the operator can repair the named
file and restart. A startup refusal does not create an unscoped session or
silently replace an installation identity.
