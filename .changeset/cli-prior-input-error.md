---
'@namzu/cli': patch
---

`namzu exec --json` checks a prior tool call's `metadata.inputError` on the history it reads from stdin, as it already checked `inputTruncated` and `partialArguments`. The executor words its answer to that call from the field, so a `reason` other than `truncated` or `malformed`, or a `length` that is not a count, reached the model as "after undefined characters". Such history is now refused before the turn starts, naming the field, like any other invalid history.
