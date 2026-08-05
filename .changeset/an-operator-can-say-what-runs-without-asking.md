---
'@namzu/cli': minor
---

an operator can say which tools may run without asking

The kernel has had a permission engine for as long as the gate has existed —
`VerificationRule[]` with allow/deny/review, seven rule types, evaluated
first-match-wins. The CLI passed `rules: []`. So the engine ran with nothing in
it and every mutating call fell through to the same prompt, whether it was
`git status` or `rm -rf`.

A `[permissions]` table in the CLI config is now compiled into that array:

```toml
[permissions]
read = "allow"
bash = { "git status*" = "allow", "git push*" = "deny", "*" = "ask" }
```

**A tool nobody wrote a rule about is still asked about.** `ask` deliberately
emits no rule, because the gate's fallback for an unmatched call is already
`review` — if `ask` emitted something it would have to mean something different
from silence, and it does not. There is no way to spell "allow by omission":
widening the default has to be something an operator typed. A newly bridged
tool that appears tomorrow prompts, exactly as it did before this existed.

Patterns are ordered most-specific-first at compile time, because the kernel
stops at the first match — `{ "*" = "ask", "git push*" = "deny" }` would
otherwise read as a prohibition while being none. A trailing `" *"` also matches
the bare command, so `git push *` catches `git push`.

A line that cannot be read is reported and the rest still load. A permission
someone wrote and which was silently dropped is the worst outcome available
here: they believe a control is in force and it is not.
