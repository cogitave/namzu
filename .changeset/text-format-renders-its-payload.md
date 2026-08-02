---
'@namzu/cli': patch
---

A payload that brought its own rendering now uses it in text format.

A command that wants both a structured payload — what `json` and `yaml`
emit, and what a CI job parses — and a human string had to choose one.
Passing the object meant the text format dumped a nested object graph where
a report was meant to be, with the readable version sitting unused in a
`text` field one level down. `namzu eval` did exactly that in its default
format.

Found by running the built binary, not by a test. The command's own tests
asserted on the payload, which was correct, and never on what a person
sees — so the failure lived in the one place the suite was not looking.
There is now a test for it, and `json` still emits the whole payload:
collapsing that to the string would trade one broken format for another.
