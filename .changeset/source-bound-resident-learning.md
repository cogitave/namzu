---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Allow resident skill candidates to declare source revision dependencies. Their approval hash includes those bindings, and context projection withholds a bound skill unless every dependency matches fresh host observations. Unbound candidates keep their existing hashes and behavior. SDK hosts can resolve revisions per model request; the CLI resident profile supports bounded workspace-file SHA-256 observations.

Correct TUI stop messages for unresolved usage and accounting failures, including unlimited runs, so they no longer claim the token allowance was exhausted.
