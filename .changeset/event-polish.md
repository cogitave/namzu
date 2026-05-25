---
'@namzu/cli': minor
---

**Live tool activity, status glyphs, and a context gauge.**

Tool calls now feel alive: while a tool runs it shows in a live region with an animated spinner and a ticking elapsed timer, and on completion it settles into the transcript with a ✓ (green) / ✗ (red) status glyph and how long it took — e.g. `✓ Bash(npm test) · 1.2s` — above its `⎿` result. Before the first token of a reply the agent shows a `thinking…` line. The status bar gains a context-window fill gauge (`ctx ███░░░░░ 38%`, green→yellow→red as the window fills).
