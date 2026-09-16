---
"@namzu/cli": patch
---

The composer footer's `· orchestrate` marker no longer disappears at narrow terminal widths while orchestrate mode stays silently on.

Before: `orchestrate` was appended to the reasoning-effort label as one droppable unit (`effort <level> · orchestrate`, or `orchestrate` alone with no effort pinned) inside `StatusBar.tsx`'s `fitStatusLine`. That unit was dropped for room right after the working directory, well before the model — so at 40 columns, a real PTY run with orchestrate mode on and no effort menu open showed only `shift+tab to cycle       gpt-5.6-terra`: no `orchestrate` anywhere on screen, with the permission-mode badge (or its quiet reminder) and the model both still shown. Orchestrate is a persistent, behavior-changing session setting — it pins effort to the model's highest level and strengthens delegation guidance for every later turn — with no other on-screen indicator, so an operator working in a narrow pane had no way to tell it was on.

Now: `orchestrate` is its own segment, no longer bundled with `effort`, and it holds the same survival priority as the permission-mode badge. It is dropped only after the working directory, the effort label, the cycle-key reminder and the model are already gone, and only as a last resort — never truncated to a fragment of the word, and never at the cost of shrinking the badge itself to make room for it. At 100 columns the line is unaffected. At 40 columns with orchestrate on, the footer now reads `shift+tab to cycle · orchestrate` (or the equivalent with an active permission badge) instead of naming neither.

Patch, not minor: no prop, export or default changed shape — `StatusBar`'s existing `orchestrate` prop behaves exactly as documented, just fitted with a different priority under width pressure.
