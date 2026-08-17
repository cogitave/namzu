---
'@namzu/cli': minor
---

Add `/review`, which asks the agent to review the uncommitted work.

It rests on `/diff`: the same reading of the working tree, turned into a turn.

The whole command is really its prompt, because a review turn fails in two opposite directions and both read as success. It can **invent** problems — worse than no review, since somebody acts on the finding — so the instruction requires each one to name a file, a line, and the input or state that produces the wrong behaviour, and to be withheld otherwise. And it can **reassure**, or restate the diff back, which is what a model produces when it has nothing to say; so summarising is refused outright and answering "this looks right" in one line is explicitly allowed. Without an approved way to report nothing, the only available answer is to find something.

The file list is sent, not the patch. The agent has a shell and can read what it wants; pasting in a truncated patch would spend the context that reading the interesting parts properly requires, and a review of a truncated diff is a review of whatever fitted.

Over a clean tree it refuses rather than sending the turn — a review of nothing comes back reading exactly like a review of something.
