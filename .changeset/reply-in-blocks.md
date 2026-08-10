---
'@namzu/cli': minor
---

A reply arrives in whole blocks instead of typing itself out.

Token deltas used to be appended to the transcript the moment they arrived.
Nothing animated them — there is no timer anywhere in the package — but a few
characters at a time reads the same way, and an operator ends up watching a
line grow rather than reading it.

Deltas are now held and released a **block** at a time: a paragraph, a list, a
fenced code block. A short answer has no blank line in it, so it is one block
and appears whole, which is the common case. A long answer appears paragraph by
paragraph, so the screen still shows that work is happening without spelling it
out letter by letter.

**A fenced code block is never split**, even though it contains blank lines.
Cutting there would hand the renderer a fence that opens and never closes, and
the first half of a snippet would render in a different style from the second.

Nothing is lost. The tail of a reply is an incomplete block by construction, so
every close path — normal completion, a tool call interrupting the text, an
error mid-turn — flushes what is buffered before finalising. That is the one
way this could have gone wrong quietly, and it is the failure the new tests are
built around: they drive a rendered turn and assert the whole reply is on
screen, exactly once, including a reply that never completes a block at all.
