---
'@namzu/sdk': minor
---

Export `describeRule` alongside `evaluateRule`.

`evaluateRule` has been public for some time and answers only whether a rule
matched. A host driving the rules directly — rather than through
`VerificationGate` — was left holding a verdict with no words for it, and the
only way to say anything about a refusal was to switch on the rule's `type`.
That names the KIND of rule and nothing about what it said: not which tool, not
which pattern, not whether a different input could ever help.

That is the same defect the gate itself carried until its `reason` stopped
being `Matched rule: <type>`, and it was left open one layer up for anyone
using the rule primitives without the gate. The two now travel together.

Nothing is removed and no behaviour changes. If you were deriving your own
denial text from `rule.type`, `describeRule(rule)` is the sentence the gate
uses, and it is worth reading before you keep your own.
