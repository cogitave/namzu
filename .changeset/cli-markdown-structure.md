---
"@namzu/cli": minor
---

A reply's markdown looks different in the terminal, in both the default screen and fullscreen. Headings are told apart by level: level 1 is bold and underlined in the accent colour, level 2 bold in the accent colour, level 3 bold in the body colour, levels 4 to 6 bold in the muted colour (before, levels 1 and 2 showed as plain bold like the rest). A quote (lines starting with `>`) is drawn with a bar down its left edge on every row, its text in italics, and a quote inside a quote gets two bars; before, the `>` was printed as text. A line of `---`, `***`, `___` or `- - -` on its own is drawn as a horizontal line up to 40 cells wide; before, the characters were printed. A `>` in the middle of a line, and anything inside a code fence, stays as written. Text over `---` is a paragraph and a rule, not an underlined heading. Nothing to change on your side.
