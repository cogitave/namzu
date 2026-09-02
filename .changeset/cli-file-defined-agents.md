---
"@namzu/cli": minor
---

A project can define its own sub-agents.

`<cwd>/.namzu/agents/<name>.md` and `~/.namzu/agents/<name>.md` (project shadowing user) each define a `subagent_type` the `Agent` tool offers beside `general-purpose` and `explore`: YAML frontmatter with `name`, `description` and optionally `tools: read, grep`, `model`, `readOnly: true`, over a Markdown body that becomes the agent's prompt. The roster is the file's allowlist intersected with the parent's working set — a file cannot grant a tool the parent does not have — and `readOnly` narrows it the way `explore` is narrowed. The model is told each type's description so it can pick the right one. A file that cannot be loaded (no name, a built-in name, a bad `tools` line, an empty body) is named on stderr with its reason and the rest of the roster survives it.
