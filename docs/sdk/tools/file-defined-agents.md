---
title: Agents defined in files
description: Load delegated sub-agents from Markdown files with frontmatter, shadow them by root order, filter their tool rosters read-only or by name, and ship the explore delegate.
type: Guide
status: stable
resource: packages/sdk/src/agents/file-definitions.ts
tags: [sdk, tools, agents]
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# Agents defined in files

A sub-agent can be a Markdown file the way a skill is: frontmatter naming it,
a body that is its prompt. The kernel reads the files; the host decides which
directories to read and in what order.

## The file

```md
---
name: reviewer
description: Reviews a diff for correctness and reports findings.
tools: read, grep, glob
readOnly: true
model: claude-sonnet-5
---
You review code. Read the diff, then every file it touches …
```

| Key | Meaning |
| --- | --- |
| `name` | Required. Must not be a name the host reserves (`general-purpose` and `explore` by default). |
| `description` | Required. What the parent model sees when choosing a delegate. |
| `tools` | Optional. One comma-separated line of tool names; the roster is the parent's tools intersected with it. Absent means the parent's working set. |
| `readOnly` | Optional. `true` narrows the roster to tools that declare themselves read-only and are trusted to say so. |
| `model` | Optional. A model id the host resolves. |

The body is the system prompt, cut at `MAX_AGENT_FILE_CHARS`. Frontmatter
takes scalars only; a YAML list under `tools` is refused with a reason.

## Discover

```ts
import { discoverAgentDefinitions } from '@namzu/sdk'

const { definitions, skipped } = await discoverAgentDefinitions([
  { dir: '/home/me/.namzu/agents', source: 'user' },
  { dir: '/work/project/.namzu/agents', source: 'project' },
])

for (const file of skipped) console.warn(file.path, file.reason)
```

Roots are read in order and a later root shadows an earlier one by name, so
the project's `reviewer.md` wins over the user's. A file that cannot be
loaded — no frontmatter, a reserved name, a list where a scalar was expected —
is returned in `skipped` with its path and reason rather than dropped; a host
that says nothing about it has chosen to. A root that does not exist
contributes nothing.

## Build the roster

```ts
import { filterReadOnlyTools, filterToolsNamed, ToolRegistry } from '@namzu/sdk'

const parent = new ToolRegistry()
const readOnly = filterReadOnlyTools(parent)
const named = filterToolsNamed(parent, ['read', 'grep'])
```

Neither filter can widen: both return a registry drawn from the source.
`filterReadOnlyTools` decides with `isTrustedReadOnly`, the predicate the
authorization gate uses — a connected server's tool that merely claims to be
read-only does not qualify unless the server's hints are trusted.

## The explore delegate

`EXPLORE_AGENT_ID`, `EXPLORE_AGENT_DESCRIPTION` and `EXPLORE_AGENT_PROMPT`
are the identity and prompt of a read-only delegate for lookups: where a
symbol is defined, which files reference it, how a module works. A host
registers it with `filterReadOnlyTools(parent)` as its roster and, because
its roster cannot mutate anything, may let it run without permission
prompts.

## Related

- [Built-in tools](./built-in.md)
- [Tool safety](./safety.md)
