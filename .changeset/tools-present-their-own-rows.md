---
'@namzu/sdk': minor
'@namzu/cli': patch
---

Tools now decide how their calls and results are shown, and the CLI stopped
matching on tool names.

`write` gains `presentCall`, returning a diff with an empty `before` —
which is what a write is: whatever was there is gone and this replaces it.
`edit` and `write` both gain `presentResult` returning a plain label, which
is what suppresses the detail block: the content was already shown under
the call, and repeating it doubles the longest rows in a transcript to say
nothing new. That decision used to be a host matching two names.

`createToolPresenter`'s result fallback changed from a `generic` view
truncated to 120 characters to a `terminal` view carrying the whole output.
A host renders a result across many rows and decides for itself how many
fit — that is a property of its terminal, not of the tool — and truncating
in the kernel destroyed text no host could then recover. A tool that wants
the one-line form returns a `generic` view itself.

In the CLI this deletes `summarizeToolInput`, `previewToolInput`,
`toolStartDetail` and `toolEndDetail`, replacing four name-matching
functions with one `viewToLines`. A tool the CLI has never heard of — an
MCP server's, a plugin's — now gets a diff if it asks for one, where before
it got a truncated JSON blob no matter what it did.
