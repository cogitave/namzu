---
'@namzu/sdk': patch
---

the fork-bomb entry in the dangerous-command list could not match a fork bomb

`DANGEROUS_PATTERNS` is what the `deny_dangerous_patterns` verification rule
consults, and what `namzu run`'s own docstring means when it promises that in a
non-interactive run "the safety gate still hard-denies catastrophic commands".

The fork-bomb entry was written `/:(){ :\|:& };:/`. In a regular expression
`()` is an empty capture group, not two literal parentheses — so that pattern
described the string `:{ :|:& };:`, which is not valid shell and which nobody
would ever type. Probed: it returned `false` for `:(){ :|:& };:` and for every
other spelling of it.

The replacement matches on **self-reference** rather than on one literal
spelling — a fork bomb is a function whose own name appears on both sides of a
pipe, is backgrounded, and is then invoked. So `bomb(){ bomb|bomb& }; bomb` is
denied along with the `:` form, while `watch(){ tail -f log | grep E & }` — a
function that merely contains a pipe and a background job — is not.

No test named a fork bomb before this change, which is how it survived. There
are now sixteen.
