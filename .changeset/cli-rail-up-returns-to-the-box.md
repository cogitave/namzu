---
'@namzu/cli': patch
---

The arrow keys now move both ways between the input box and the rows under the status row. Up from the first stop (the shell pill, or the first agent or workflow row) puts the keyboard back in the input box with your draft and caret as they were, so Esc is no longer the only way out. Ctrl+P and Ctrl+N work as Up and Down while the rows have the keyboard. Down on the shell pill, when no row follows it, opens the Background list, like Enter. Down also reaches the rows from a typed draft (caret on its last line, no suggestions open) and leaves the draft untouched. While a reply is running, the first Esc on a row only leaves the rows; the next Esc interrupts.
