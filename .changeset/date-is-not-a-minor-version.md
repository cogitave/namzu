---
'@namzu/sdk': minor
'@namzu/anthropic': patch
'@namzu/http': patch
---

a model id's date suffix is no longer read as its minor version

Three copies of one regular expression matched Claude model ids — the capability
table plus two drivers — and all three had the same defect: the minor-version
group was `(\d+)`, which swallowed the 8-digit date suffix.

Measured against the shipped pattern:

```
claude-sonnet-4-20250514   ->  major=4  minor=20250514
claude-opus-4-1-20250805   ->  major=4  minor=1
```

So a dated id naming no minor version compared as enormously *newer* than one
that does, and every capability gate keyed on `minor >= n` inverted for exactly
those ids. `claude-sonnet-4-20250514` was classified as a 4.7+ model: the driver
sent it `thinking: {type: 'adaptive'}`, silently discarding a caller's
`budgetTokens`, and cleared the 4.5 gate that enables strict tool inputs.

`parseClaudeModelVersion` and `claudeVersionAtLeast` are now exported from
`@namzu/sdk` and used by both drivers and the capability table. A real minor
version is one to three digits; a date is eight, and the group is bounded
accordingly. An id the parser does not recognise makes `claudeVersionAtLeast`
return `false` — a capability gate must not open for a name it does not
understand.

The comment above the old parser warned that "a second, subtly different model
matcher is how two capability decisions drift apart on the same model name."
There were three.
