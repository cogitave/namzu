---
'@namzu/sdk': patch
'@namzu/cli': patch
---

Every diagnostic these two packages emit now has a constant message body, and the identifiers that used to be interpolated into it are attributes beside it.

87 `Logger` call sites across 29 files were rewritten. `` `Tool execution error: ${toolName}` `` is now `'Tool execution error'` with `namzu.tool.name` in the attribute bag; `` `Tenant registered: ${id} (${name})` `` is now `'Tenant registered'` with `namzu.tenant.id` and `namzu.tenant.name`. Where the neighbouring bag already carried the value, only the message changed; where it did not, the value moved into a new `namzu.*` key in the same edit — a constant body that costs an operator the identifier would be a worse record, not a compliant one.

**If you grep, alert on, or group by these message bodies, your queries need updating.** No exported type, signature or default changed, and nothing fails to compile — this is diagnostic output, not API — but a log pipeline matching the old interpolated text will stop matching. The upside is the reason for the change: an operator can now grep one literal for every occurrence of an event, and a dashboard can group by it, neither of which was possible when each occurrence rendered a different string.

`scripts/check-log-standard.mjs`'s rule-3 ratchet (`constantBodyViolationCount`) goes 87 → 0. At zero it stops being a budget and becomes a floor: the *first* new template literal in a `Logger` call fails CI, not the hundredth. Rule 4 (`namespacedAttributeKeyViolationCount`) is unchanged at 794 and still being worked down.
