---
"@namzu/desktop": minor
---

An approval is now one card instead of three boxes. The question is one sentence with the file or command as a chip and the size of the change at the right ("Edit `src/auth/session.ts`?", "+1 −1"). What the request itself says about the consequence comes first, with a warning mark: that Namzu asks about it every time, that the path is outside the project folder, a delete, a replaced file, elevated rights, a command that looks like it deletes. Nothing the model wrote about its own action is shown. The change or command is four rows with a link that says how much more there is ("Show all 24 lines") and opens it in place.

**Accept is no longer held until a long command or diff has been scrolled to its end**; it works at once. The 400 ms guard after a card appears, Reject-first keys on risky commands and deletes, and the withheld "allow for this conversation" are unchanged. Enter still accepts and Esc still rejects; the keys now read on the buttons' tooltips instead of in a line of text. "Wrap lines", "Copy" and "Tell Namzu what to do instead" moved to a "..." menu on the box. "Allow for this conversation" is an outline button.

While a decision waits, the composer is a 40 px bar saying so, with an outlined Stop that turns red on hover; the model word, context ring and microphone come back once you answer. The turn in flight is one line (a mark, the step it is on, the time, a chevron) with its actions behind the chevron; a failed or refused action keeps the work open.
