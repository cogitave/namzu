---
"@namzu/cli": patch
---

Keep terminal and ACP conversations running when refused or truncated tool
arguments produce an invalid presentation. A malformed write call no longer
throws while drawing its label: the CLI uses the tool name, preserves the
original error and lets the model repair its input and complete the turn.
Valid tool views, tool validation and permission checks retain their behavior.
