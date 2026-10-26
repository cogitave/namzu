---
"@namzu/cli": minor
---

`/context` now draws where the context goes: a grid for the window with a legend of categories (system prompt, tools, MCP tools and instructions, agents, memory files, skills, messages, free space), lists of MCP tools, agents, memory files and skills with their sizes, and advice when a tool, file reads or memory files take a large share. The old one-line summary appears only before the first reply; `/context details` still shows how older messages were summarised, below the grid. Nothing in `exec` or the editor protocol changes. `/context all` is accepted and shows the same view.

The grid and its legend draw in the active theme's colours, so the light, colorblind-friendly and ANSI-only themes recolour them like everything else.
