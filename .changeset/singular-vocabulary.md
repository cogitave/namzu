---
'@namzu/sdk': major
'@namzu/cli': patch
'@namzu/anthropic': patch
---

namzu's own vocabulary, everywhere.

Comments across the kernel explained namzu's design by naming another
product: "mirrors X's container architecture", "reference: X's
`normalizePathForSandbox()`", "which is what Y and Z both do", "Claude Code
uses 2000 for the same reason". Behaviour was correct throughout — this is
about what the code says it is. A kernel that explains itself by citation
reads as a reimplementation of something else, and namzu is not one.

Every such comment now states the reason directly. Where a rule exists
because a provider requires it, the comment says what the requirement is
rather than whose it is — which is also more useful, since the same
requirement usually holds for more than one provider, and a reader who has
never used the named one can still follow it.

**Breaking (types only, no runtime behaviour):**

- `ToolCatalogSurface`: the `'cowork'` member is now `'supervised'`.
- `ToolSource.skill.type`: `'anthropic' | 'custom'` is now
  `'published' | 'custom'`.

Both are descriptive metadata with no construction site anywhere in the
workspace, so nothing internal moved. An external consumer that names
either value gets a compile error pointing at the line.

**Deliberately unchanged**, because these are addresses rather than
borrowed naming: model-id prefixes in the context-window table (data the
runtime matches against), API-key detection patterns in the guardrail
presets (a pattern is worthless if you cannot tell what it detects),
namzu's own provider package names, and the credential-store integration in
the CLI, whose service name and file path are literally the other tool's.
