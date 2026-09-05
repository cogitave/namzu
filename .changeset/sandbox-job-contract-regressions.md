---
"@namzu/sdk": patch
"@namzu/cli": patch
---

Add regression coverage for background jobs in supported sandboxes: the CLI
offers the capability, and the executor routes process creation and cleanup
through the sandbox. Correct an obsolete CLI test and documentation index
entry that still expected all sandbox background jobs to be unavailable.
Runtime behavior and public APIs are unchanged.
