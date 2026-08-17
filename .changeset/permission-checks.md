---
'@namzu/cli': minor
---

`permissionChecks`: state what your permission table decides, and have it checked

A `[permissions]` table is a set of globs compiled to regular expressions and
matched against a subject the operator never sees. Every stage of that has been
wrong at least once, and each time the failure was silent and permissive — a
rule that read like a prohibition and decided nothing, an `allow` whose match
began wherever the text did, a glob whose trailing star reached past the end of
a command. The config looked right in every case, and nothing an operator could
run would have told them otherwise.

A new optional `permissionChecks` array states the decision the operator
believes their table produces, and every entry is evaluated against the compiled
table at startup:

```json
"permissionChecks": [
  { "tool": "bash", "input": { "command": "git status --short" }, "expect": "allow" },
  { "tool": "bash", "input": { "command": "git status && rm -rf ~" }, "expect": "ask" }
]
```

The second is the point: it asserts a NEGATIVE — that a rule does not stretch to
cover a command nobody named — which is exactly what a table of globs cannot be
read for.

A mismatch is reported by index with the decision it got, the one expected, and
the rule that decided; the run continues, because a wrong expectation should
cost that line and not the whole policy. A check that cannot be read is reported
rather than skipped. The dangerous-pattern floor is off while checking, so a
check written about the table cannot be answered by something the table does not
contain — and cannot keep passing after the rule it was written for is deleted.

Not settable from the environment: a variable that could replace the checks
could also empty them.
