---
'@namzu/sdk': patch
---

With `perCallReview` on, a call that waited for its turn is checked against the rules, grants and `covers` as they are then, so a rule remembered by an earlier answer covers a later identical call and it is not asked again. Questions that open together now open in the order the model wrote the calls, and a turn that a refusal stopped announces its refused calls in that order. Nothing changes for a host that does not set `perCallReview`.
