---
'@namzu/sdk': minor
---

Allow `SkillTool` calls without a name to page model-invocable skill metadata within `maxToolOutputChars`. Operator-only entries remain undisclosed, oversized entries produce one bounded warning, and continuation cursors become stale when the catalog or active cap changes. `SkillRegistryRef` gains an optional audience-safe `catalog()` capability; existing structural registries continue to support named skill loading and explicitly refuse list mode.
