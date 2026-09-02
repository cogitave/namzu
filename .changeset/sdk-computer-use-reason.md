---
"@namzu/sdk": minor
---

`ComputerUseCapabilities.unavailableReason`: when a host loaded but the desktop did not answer, the `computer_use` tool stays mountable with every capability false and the reason in its description and in every refusal — "requires capability screenshot which is not available on this host … the desktop did not answer: <why>. Do not retry; tell the user." The model reads why once instead of finding an absent tool or a bare error.
