---
'@namzu/sdk': patch
---

The third-party-name audit now covers prose, not just source

The rule namzu holds is that nothing here takes its naming from another system and no brand appears in prose. The guard that enforces it scanned `.ts` only — so the largest prose surface in the repository, every README and published page, was never checked, and it had accumulated exactly what the rule refuses: a competitor feature grid, a scoring table, "in the spirit of X", "our tool names mirror Y's table verbatim", and a sandbox tier matrix written as market positioning.

Markdown is scanned now, with the same distinction the source side already draws. An inline code span, a fenced block, a link target and YAML frontmatter are values a reader types verbatim — a package path, a model id, a keychain item — and they are exempt. A published page may also name a service namzu ships a driver for, because telling an operator what it connects to is the page's job; source comments get no such licence, since a vendor is never the reason namzu's own code has its shape.
