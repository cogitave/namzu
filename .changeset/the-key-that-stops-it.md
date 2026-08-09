---
'@namzu/cli': patch
---

**The permission prompt names `Ctrl+C`, and says why it is different from `n`.**

`n` and `Esc` decline the tool call and the turn **continues** — the agent is
told, and tries something else. `Ctrl+C` declines and **stops the turn**. Two
different decisions, and the prompt listed only the first.

So the only key that stops namzu was the one an operator could not see from the
screen that governs it. Someone who wanted it to stop pressed `n`, watched it
carry on with a different approach, and had nothing on that screen to tell them
otherwise; the distinction existed only in the documentation.

The prompt now lists all four keys, grouped by outcome, on two lines — at four
keys a single line wraps mid-key on a narrow terminal, and this is the box you
read while deciding. The status-bar hint keeps its compact three-key echo, which
is budget-constrained by construction and shares a line with the working
directory, the provider and the model.

No behaviour changed. `Ctrl+C` has always done this.
