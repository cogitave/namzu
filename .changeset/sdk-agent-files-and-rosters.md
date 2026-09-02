---
"@namzu/sdk": minor
---

Delegates a host can define from files, and rosters narrower than the parent's.

- **`discoverAgentDefinitions(roots)`, `parseAgentFile`, `parseAgentMarkdown`** — a sub-agent defined in a Markdown file the way a skill is: frontmatter with `name`, `description`, optionally `tools` (one comma-separated line), `model` and `readOnly`, over a body that is the prompt. The host passes an ordered list of roots and later roots shadow earlier ones by name; a file that cannot be loaded is returned with its path and reason rather than silently dropped. Names a host reserves (`general-purpose`, `explore` by default) are refused.
- **`filterReadOnlyTools(registry)`** — the source's tools that declare themselves read-only and are trusted to say so, decided by `isTrustedReadOnly`, the same predicate the authorization gate uses; **`filterToolsNamed(registry, names)`** — the source intersected with an allowlist. Neither can widen.
- **`EXPLORE_AGENT_ID` / `EXPLORE_AGENT_DESCRIPTION` / `EXPLORE_AGENT_PROMPT`** — the read-only delegate's identity and prompt, for a host to build with `filterReadOnlyTools` and its own doctrine around it.

Nothing existing changed.
