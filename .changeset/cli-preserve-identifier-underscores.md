---
"@namzu/cli": patch
---

Preserve underscores within identifiers in assistant replies. For example,
`RUN_LIMITS_READY` now displays exactly as returned instead of losing its
underscores to italic formatting. Standalone underscore emphasis still works;
stored conversation content is unchanged.
