---
'@namzu/sdk': minor
---

An agent file's frontmatter now also reads `disallowedTools`, `effort`, `maxTurns`, `background`, `isolation` (`worktree`) and `skills`, and `model: inherit` means no model line. `AgentFileDefinition` gains the matching optional fields. A file that already loads still loads; a file that newly sets one of these keys with a value it cannot use (an unknown effort, a `maxTurns` that is not a positive whole number) is refused with its path and reason, as a bad `tools` line already was.
