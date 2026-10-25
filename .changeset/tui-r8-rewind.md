---
"@namzu/cli": major
"@namzu/sdk": minor
---

Esc twice on an empty message now opens a rewind dialog instead of the previous-prompt picker, and the first Esc no longer shows "Press Esc again to edit a previous prompt". The second Esc counts only within 800 ms of the first.

What changes for you: to edit an earlier prompt, press Esc twice, pick the prompt, and choose "Restore conversation". It does what the old picker did (continues in a new conversation before that prompt and puts the prompt back in the composer; the original stays in `/resume`). The dialog also offers "Restore code" (puts files back with the same drift-checked plan as `/restore`), "Restore code and conversation", "Summarize from here" and "Summarize up to here", and shows what each prompt would do to your files. `/rewind` opens the same dialog, with `/undo` and `/checkpoint` as aliases; `/restore` is unchanged. A project command or plugin command named `undo`, `checkpoint` or `rewind` is shadowed by the built-in.

`@namzu/sdk` adds `compactSessionRange` (and `CompactSessionRangeParams`): like `compactSession`, but it summarises only the messages from one recorded message id up to another and leaves the rest of the context verbatim.
