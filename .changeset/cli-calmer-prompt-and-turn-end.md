---
"@namzu/cli": minor
---

A calmer permission prompt and turn end. The permission box names a file relative to the working folder and leaves out a leading `cd <the working folder> &&` from a shell command (in the box, the waiting row and the collapsed tool rows; a `cd` anywhere else is kept and the exact input behind `d` is unchanged), and a call waiting for its answer shows one waiting row instead of two. The "Save it as a reusable skill?" suggestion is shown at most once per run of the program and only after a turn that used three or more different tools (it was two before); `skills.suggest: false` still turns it off. The "Changed N files · ran …" line cuts a long command after a whole word, with ` …`, never inside a word or a quoted string, and leaves out a leading `cd` to the working folder.
