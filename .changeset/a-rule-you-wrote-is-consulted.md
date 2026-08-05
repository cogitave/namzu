---
'@namzu/sdk': minor
---

a policy rule you wrote is actually consulted, and a refusal says what it said

Two defects in the verification gate, found while designing an operator-facing
permission surface on top of it.

**A rule could be silently unreachable.** `allowReadOnlyTools` was expanded
into a rule ahead of the operator's own, and the gate stops at the first match
— so a rule like "prompt me before every read" was never consulted while that
flag was on. Not rejected, not warned about, just never reached. Someone who
writes a control and is silently ignored gets the worst outcome available: they
believe it is in force and it is not.

The read-only allowance now goes LAST, which makes it what it always was in
substance — a default for tools nobody wrote a rule about, rather than an
override of the rules they did write. **The dangerous-pattern denial still goes
first and still outranks everything**, so an operator rule cannot open what the
floor closes.

**A refusal told the model nothing it could use.** The reason was built as
`Matched rule: ${rule.type}`, so a denial arrived as *"Blocked by the
verification gate: Matched rule: deny_by_name"* — the KIND of rule and nothing
about it. Not which tool, not which pattern, not whether a different input
would fare better.

That difference is behavioural, not cosmetic. Told only that it was denied, a
model rewords the same call and tries again, because nothing says the retry is
pointless. Told that a pattern rule denies `git push*`, or that a by-name
denial is about the tool rather than the input, it can stop and say so. A
refusal that cannot be reasoned about produces thrashing; one that can produces
a route around it.

`describeRule` is exported, so a host rendering its own approval UI can show
the same sentence the model got.
