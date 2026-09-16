---
'@namzu/sdk': minor
---

`Sandbox.readFile` takes an optional options parameter, and `Sandbox` gains an
optional `readFileStream`.

`readFile(path, options?: SandboxReadFileOptions)` accepts `offset`, `length`
and `signal`. It is source-compatible in both directions: callers may go on
writing `readFile(path)`, and a backend may go on declaring the one-parameter
form and still satisfy the widened signature — no implementation has to change.
A backend that accepts the parameter and then ignores `offset`/`length` does
not satisfy it: returning the whole file where a slice was asked for is a wrong
answer, not a degraded one, so such a backend must reject instead.

`readFileStream?(path, options?): AsyncIterable<Buffer>` is optional in the
same way `openTerminal?` is. A backend that cannot read a file incrementally
omits it rather than implementing it by reading the file whole and chopping the
result up, so a caller that needs bounded memory refuses an absent method
instead of silently getting the behaviour it was trying to avoid.

The SDK's own local provider serves the range rather than refusing it: a slice
of a file on a local filesystem is one positional read, and a range that runs
past the end returns the bytes that exist. `signal` is honoured on both shapes
— handed to the whole-file read, and checked on either side of the positional
one, which takes no signal of its own.

What this changes for a caller of the agent-backed backends in
`@namzu/sandbox`: a `readFile` of a file around 384 MiB or larger used to fail
with `Cannot create a string longer than 0x1fffffe8 characters`, because the
guest base64-encoded the whole file into one string. It now succeeds. Hosts
that drain agent-produced output files before `destroy()` are the case this is
for.
