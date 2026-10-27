---
'@namzu/cli': minor
---

The `Agent` tool now offers a built-in `plan` type beside `explore` and `general-purpose`. It has the same reading and searching tools as `explore`, cannot edit or run commands, starts without the launch question, and returns a step plan with the files to change and the risks. A project agent file named `plan` replaces the built-in of that name; rename the file if you want both.
