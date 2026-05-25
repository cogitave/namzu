---
'@namzu/cli': minor
---

**Assistant replies now render as markdown.**

Responses were shown as flat text; they now render the way Claude Code / gemini-cli present them:

- **Code blocks** in a distinct color on a dim left rule, with the language label.
- **Inline `code`** in a code color.
- **Bold** and *italic* emphasis.
- Headings (bold, accent for `#`/`##`).
- Bullet and numbered lists with a marker gutter and hang-indented wrapping; consecutive items stay tight.

Implemented as a small, dependency-free markdown parser (unit-tested) plus an Ink renderer. Only assistant messages are rendered as markdown — your input and tool/system lines stay verbatim. Syntax highlighting inside code blocks is a follow-up.
