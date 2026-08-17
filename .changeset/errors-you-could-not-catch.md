---
'@namzu/computer-use': minor
---

The three errors this package throws are now exported.

`AdapterUnavailableError`, `ActionCapabilityError` and `SpawnError` have been
thrown since the first release and none of them was importable, so the only way
to tell "the binary is not installed" from "the command ran and failed" was to
match on `err.message` — a sentence this package is free to reword. The README
documented them as an error surface the whole time.

`AdapterUnavailableError.missing` carries the list of binaries to install, which
is the actionable half and was unreachable without the type. `SpawnError.result`
carries the exit code and stderr.

`SpawnOptions` and `SpawnResult` are exported as types alongside them.
