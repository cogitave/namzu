---
'@namzu/anthropic': patch
---

Keep the optional Claude Code version probe out of framework filesystem
tracing so server bundles do not include the consumer's entire project.
