---
'@namzu/sdk': minor
---

`read` now numbers lines as a right-aligned number, an arrow and the line (`    12→\tconst x`) instead of the number, a tab and the line, so a tab in a file's own indentation is no longer mistaken for the separator; anything that parsed `N<TAB>text` out of read output must split on the arrow instead. `edit` also recovers an `old_string` whose lines match the file in exactly one place but are indented differently by the same amount on every line (tabs or spaces), applies it with `new_string` re-indented the same way and says so; a failed match prints the file's own lines with `→` for a tab and `·` for a space; and a batch that fails names every hunk that did not apply, still writing nothing. The read output is text for the model, not an exported API (the numbering helper is not part of the package exports), which is why this is a minor; code outside the package that parsed the old tab-separated text must change.
