---
'@namzu/cli': patch
---

**TUI redesign — cleaner, modern layout (gemini-cli / claude-code grade).**

The interactive UI was visually heavy and cramped. It's been reworked to match the patterns of leading agent CLIs:

- **Borderless, edge-to-edge transcript.** The round box around the message stream is gone; messages now use a two-column layout — a glyph gutter (`>` you, `✦` namzu, `⚙` tool, `·` system) plus the content, with wrapped lines hang-indented. No more redundant role-label line.
- **Input field composer.** A rounded rule above and below the input (no side borders) with a `>` prompt and a dim placeholder, instead of a full box.
- **One-line status bar.** The footer now truncates with an ellipsis on narrow terminals instead of wrapping into a mangled two lines, while keeping per-segment color.

Pure visual changes; no behavior or API changes.
