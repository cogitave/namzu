---
'@namzu/sdk': minor
---

A tool can set a tighter model-visible cap for its own results with `maxOutputChars` on its definition (or `defineTool({ maxOutputChars })`). The turn's `maxToolOutputChars` still applies and the smaller value wins, including when a host turned the turn cap off with `0`. A result over the tool's cap is saved in the session's tool-results folder and shown as a head-and-tail preview that names the file, exactly as any other oversized result is. A tool that does not set it behaves as before.
