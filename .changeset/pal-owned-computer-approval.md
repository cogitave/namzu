---
"@namzu/cli": major
---

Manual Pal conversations now default to automatic approval for tools in their
owned virtual computer across the terminal, ACP and desktop. Previously a review
callback or the interactive composer selected Ask first, requiring repeated
approvals. To retain that behavior, explicitly choose Ask first, use
`/permissions prompt` in the terminal, or send `permissionMode: 'prompt'` through
ACP. Existing explicit desktop selections are preserved.

Ordinary conversations retain their existing defaults. Explicit Plan, strict
and review selections, configured deny rules, host escape refusal, ownership,
pause and operator-control fences remain effective. This grants no authority for
host files, other Pals or ungranted communication routes.
