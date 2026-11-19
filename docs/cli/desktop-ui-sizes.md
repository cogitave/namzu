---
type: Guide
title: Desktop sizes standard
description: The text roles, icon sizes per container, control heights and the places an accent fill is allowed in Desktop, and the tests that keep them.
resource: packages/desktop/src/renderer/ui-sizes.test.ts
tags: [cli, desktop, design, typography, icons]
generated:
  by: namzu/desktop-ui-sizes
  at: 2026-11-19
---

# Desktop sizes standard

One rule set for how big things are in Desktop, so a new screen does not pick its own. It follows
what the common desktop systems agree on (14 px body, 12 px secondary, 16 px icons in a 24 to 32 px
control, banners no larger than body text) and the scale already in `renderer/theme.css`; see
[the type scale](desktop.md#the-type-scale) for the tokens.

## Text roles

Nothing renders at an inherited size. `body` sets `font-size: var(--text-interface)` and the matching
line-height, so text that names no size reads at 14 px, not at the 16 px root (which stays the rem
base). A reply, the person's message and the message box keep their own 15 px reading size.

| Role | Token (Tailwind) | Size / line | Weight | Used for |
| --- | --- | --- | --- | --- |
| Caption | `--text-caption` (`text-xs`) | 12 / 16 | 400 | times, counts, hints, Details links, badges |
| Small | `--text-small` (`text-sm`) | 13 / 18 | 400 or 500 | sidebar rows, menus, tabs, toasts, quiet rows |
| Interface | `--text-interface` (`text-base`) | 14 / 20 | 400, 500 for a label | control text, settings rows, banners, panel and conversation titles |
| Reading | `--text-reading` | 15 / 22 | 400 | reply prose, the person's message, the message box |
| Heading | `--text-heading` (`text-lg`) | 17 / 24 | 600 | dialog and section titles |
| Title | `--text-title` (`text-xl`) | 20 / 28 | 600 | page titles |
| Display | `--text-display` (`text-2xl`) | 28 / 36 | 400 | the home heading only |

Weights: 400 for sentences, 500 for labels, buttons and the titles of a tab, a panel or the
conversation, 600 only for headings and the one active item of a group. A banner, alert or notice is
at most interface size, its sentence is 400, a title line inside it may be 500, and it has no blur.
A size class that names nothing (`text-ui-base` was one) does nothing and leaves the text at the
inherited size; use the Tailwind aliases above.

## Icon sizes by container

| Container | Icon |
| --- | --- |
| inline in text, a chip or a badge | 12 |
| a row action of 24 px (`icon-xs`) | 14 |
| a list or sidebar row, 28 to 32 px high | 16 (`--frame-icon-slot`) |
| a toolbar, the rail, a tab bar, the foot, the composer row | 16 |
| a header or dialog button of 36 px | 16 (20 is allowed) |
| an empty state or a hero | 20 to 24 |

One size per bar, and never above 16 px in a toolbar, rail, row or the composer row. A button's own
icon, a select chevron and a composer control are 16 px at every window width; there is no 18 px step for a narrow window (only the empty-state tile, a 36 px feature tile, draws 18). A drawn character (a
Pal's mark) is not a glyph and may be 18 high.

## Control heights

24 px compact (a row action, a chip, the effort thumb), 28 px default (toolbar, tab, rail, foot),
32 px form field and large button, 36 px header band. A coarse pointer raises the hit area to 44 px
through the button's `after:` rule; the icon does not grow.

## Where an accent fill is allowed

1. the one primary button of a surface;
2. the send button;
3. a selected switch or radio;
4. a status dot of 8 px or less.

Not allowed: a filled accent circle or square as a secondary or sidebar control, an accent fill that
stays for days, or more than one accent fill in a view. A waiting update is therefore the same
28 px ghost rail button as its neighbours, a 16 px download glyph in the muted colour, with a 6 px
accent dot at the top right as the only colour.

## What keeps it

`renderer/ui-sizes.test.ts` fails on: a `text-ui-*` class or any text size class `theme.css` does not
define; a `body` without the interface size; an icon above 16 px in a rail, tab, toolbar or the
composer row (the Pal mark is listed with its reason); a button icon at 18 px; a filled accent circle
that is a button or a badge; and a 600 weight on an alert or a banner. `renderer/type-scale.test.ts`
still owns the sizes and weights themselves.
