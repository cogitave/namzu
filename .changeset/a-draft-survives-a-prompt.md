---
'@namzu/cli': patch
---

A draft is no longer destroyed by a permission prompt, or by interrupting a turn

The composer stays editable while the agent works, and the docs encourage typing
a follow-up there. Two separate mechanisms then threw that text away without the
operator doing anything to ask for it.

**The permission overlay unmounted the composer.** It was rendered in a ternary
*against* the composer, so when the agent asked to run a tool the composer was
removed from the tree and React discarded its state — the sentence in progress,
any pasted-text chips, and any pasted images. Nothing was pressed; the prompt
simply arrived. The overlay and the composer are now siblings, and the composer
draws nothing while the prompt is up instead of ceasing to exist.

**Esc cleared the draft while interrupting a turn.** Both handlers fire on one
keypress: the app aborts the turn and the composer cleared itself. The status
bar advertises Esc as the interrupt, so following the instruction on screen
destroyed the draft. A running turn now owns Esc; with nothing running, Esc
still clears the composer, which is what it is for.

Nothing is required of you, and nothing looks different until the moment it
used to lose your text.
