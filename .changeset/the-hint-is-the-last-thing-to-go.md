---
'@namzu/cli': patch
---

The status bar no longer truncates away the keys it is there to advertise

The footer is one line that cuts off at the terminal edge, and the hint — the
only place any key is named — sat at the end of it. So the hint is what got cut.
At an ordinary 100-column terminal it disappeared entirely, and not only on a
deep path: a realistic provider and model fill the line between the working
directory and the hint, so even `/home/dev/api` lost it.

That made a set of recent fixes invisible rather than wrong. The trust gate
advertising `Esc`, the permission prompt naming every key that decides it, and
the picker naming its exits all exist on screen in exactly one place, and on a
normal terminal that place had already been cut off.

The line is now budgeted before it is drawn. The hint and the run state are
never dropped; everything else yields, in the order of what can be recovered
some other way:

1. **usage** and **the context gauge** — `/cost` prints both exactly.
2. **the provider label** — the longest segment and the least distinctive, since
   the model name implies it.
3. **the working directory**, shortened from the left so the leaf directory
   survives — `…/packages/core` still tells you where you are.
4. **the model**, and only then the path entirely.

Nothing changes on a wide terminal with a short path, which is where this looked
fine all along.
