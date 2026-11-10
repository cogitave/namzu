---
'@namzu/sdk': patch
'@namzu/evals': patch
---

The `edit` tool no longer refuses a call whose meaning is clear: an empty `edits: []` next to one `old_string`/`new_string`, or (as a precaution) a one-entry `edits` that repeats the top-level edit, now applies as that single edit. A real conflict is still refused, now with both accepted shapes shown. Validation errors from every tool name the field in plain words instead of zod's "Too small" wording. Nothing to change on your side; a host that matched the old message text of these refusals should match on the `invalid_arguments` failure reason instead. `@namzu/evals` gains one scripted case for the empty-batch call.
