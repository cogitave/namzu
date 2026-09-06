---
type: Reference
title: Terminal design
description: Namzu's visual identity, reading order and interaction boundaries in the terminal.
resource: packages/cli/src/tui/App.tsx
tags: [cli, tui, design, accessibility]
status: stable
---

# Terminal design

Namzu uses warm neutral text with copper accents on the terminal's own
background. The compact header pairs a continuous-stroke N monogram with the
workspace and connection identity. Narrow terminals use the three-point `∴`
signature. The header is printed once into native scrollback; the footer keeps
the current model, reasoning effort and interaction keys visible. Colors use
the ANSI 256-color palette so neutral text stays neutral on reduced-color
terminals.

## Reading the conversation

The `›` mark identifies an operator message and `∴` identifies a Namzu reply.
Tool results remain grouped beneath their calls, with expandable output and
diffs. Color supports the text and symbols: errors, permissions and task states
retain explicit labels. Raw output remains the original source projection.

A single copper rail marks the writing area. It becomes quiet while another
surface has focus. Opening a permission prompt, command picker or agent view
keeps the composer mounted so its draft and attachments survive the transition.
Existing submit, queue, steering and history keys keep their behavior.

The Working indicator owns the conversation's activity animation. Reply marks
and tool rows remain steady. Elapsed time, bounded progress text and task status
carry information without competing animations. Agent panels use the same quiet
rules and highlight the current selection with the accent color.

When the full previews would crowd the input area, activity shows the current
tool and total tool count; the plan shows the current step and completion
counts. The full lists return when space allows. These panels also reserve space before the transcript
keeps any older messages in its redrawable tail.

## Terminal boundaries

The interface uses the normal terminal buffer so completed output remains in
native scrollback. Only the current work is redrawn. Changing terminal width
keeps the selected agent and the input draft, while model/path text yields to
the keys needed to leave a prompt. The palette targets dark backgrounds; the
application does not paint a full-screen background or depend on color alone.

Screen regressions drive the production Ink renderer through a terminal
emulator. They check wrapped input, short viewports, retained drafts, normal
scrollback and the amount of output emitted during streaming. These checks use
controlled session events and require no model calls.
