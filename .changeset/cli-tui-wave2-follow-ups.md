---
'@namzu/cli': patch
---

Four small things on the terminal screen, with no setting to change and nothing to switch off.

- The `(ctrl+o to expand)` hint (in the fullscreen view `(click to expand)`) is never cut across two rows. When it does not fit after the text on a narrow window, it moves whole to a row of its own, in the column the text continues in, with the `·` before it left off (before, `expand)` stood alone on the next row, for example under the last agent of a finished batch at 80 columns). Where it fits it is drawn exactly as before. In a window too narrow for the whole hint it reads `(ctrl+o)` or `(click)`, and where not even that fits it is left off (the row still opens). This holds for every row that carries a hint and in `namzu watch` on a terminal.
- A reopened conversation (`namzu -c`, `/resume`) names its agents as it did live: `general-purpose (Check a)` rather than the start of the prompt, and its `Worked for` line carries the total the agents spent (`· 1.6k tokens`). Nothing new is written to the saved record: the short name was already kept beside each agent and the totals are in the conversation's own log. An agent saved before the short name was kept is still named by the start of its prompt.
- `/resume`, the two `/rewind` choices that replace the conversation in place (restore and summarize) and `/clear-screen` now print the last finished rows that were still held in the live region before the screen is cleared, as `/clear` and Ctrl+L do, so every row that was on screen is in the scrollback once and in order. They were lost before. (The default screen only; the fullscreen view redraws itself.)
- `namzu watch` puts the hint one space after the text, as the screen does (it was two). It still prints the session's record as text: the fence lines of a code block stay (the code between them is in colour on a terminal) and agents have no rows of their own there; the docs now say so.
