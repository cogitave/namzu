---
'@namzu/sdk': minor
---

`AcpPromptOptions` gains an optional `hypermode?: boolean`, and the ACP server forwards it to the host instead of refusing the prompt with "Invalid prompt settings". A host that does not read it ignores it. Nothing to change for existing callers.
