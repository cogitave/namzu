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
