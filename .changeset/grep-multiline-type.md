---
'@namzu/sdk': minor
---

The `grep` tool takes two new optional arguments. `multiline` lets a pattern span lines (`.` matches a newline, `^` and `$` match at line boundaries) and prints every line a match covers. `type` limits the search to one kind of file such as `ts`, `py` or `rust`; an unknown kind is refused with the list of known ones. Calls that pass neither behave as before.
