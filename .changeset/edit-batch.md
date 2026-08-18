---
'@namzu/sdk': minor
---

`edit` can carry several replacements for one file, committed together

A change that spans four places in a file is one change, and sending it as four
calls makes it four. Each call is a fresh chance to stop halfway, and the file
left after the third succeeded and the fourth did not is in a state nobody wrote
and nobody is looking at — a rename applied at two of its five call sites
compiles nowhere and reads like a bug in the code rather than an unfinished
edit.

`edits` takes a list of `{old_string, new_string}` for one `path`:

```json
{
  "path": "src/user.ts",
  "edits": [
    { "old_string": "function getUser(", "new_string": "function loadUser(" },
    { "old_string": "getUser(id)", "new_string": "loadUser(id)" }
  ]
}
```

Every entry is applied in memory, in order, against the content the entries
before it left — so a later one can target text an earlier one produced. The
file is written once, at the end, through the same atomic writer. If any entry
does not apply — not found, ambiguous, or a no-op — nothing is written at all
and the error names the entry by index, because by the time a later one fails
the string it wanted may have been consumed by an earlier one, and "not found"
alone sends the model to re-check the wrong hunk.

A call carrying both an `edits` list and a top-level `old_string` is refused
rather than resolved. That is two intentions in one object, and any precedence
would be a guess about which was meant, silently dropping an edit somebody
believes was made.

The guarantee is per file: `edits` names one `path`. Atomicity across several
files is not something this tool can enforce, so it is not offered.

Two fields became optional in the input type — the top-level `replace_all` and
each entry's — because `execute` takes the schema's output type and a defaulted
field is required of every hand-built call, including batch calls where the
top-level flag means nothing. The default is applied during normalization, so
behaviour is unchanged. `new_string` also left the model schema's `required`
list, the same trade `old_string` made when line insertion was added: which
fields a shape needs is decided by refinements that name what is missing.
