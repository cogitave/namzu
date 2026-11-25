---
"@namzu/sdk": patch
---

`substituteEscaped` now refuses a value that lands inside a shell comment or directly after a backslash the template wrote, where it cannot be quoted. Before, a newline in a value could end the comment and run the next line, and the template's backslash flipped the quote the value was given. A template that puts `$ARGUMENTS` after `#` on the same line, or right after `\`, now fails the load; move the value to its own word.
