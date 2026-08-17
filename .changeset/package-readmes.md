---
'@namzu/sdk': patch
'@namzu/cli': patch
'@namzu/sandbox': patch
'@namzu/telemetry': patch
'@namzu/files': patch
'@namzu/computer-use': patch
'@namzu/lsp': patch
'@namzu/evals': patch
---

Make each README an npm package page rather than the package's manual.

`@namzu/sdk`'s README was a twenty-four-section architecture tour, 45 KB of it; the others ran to several hundred lines each. That is the right shape for a single-package repository, where the README *is* the documentation, and the wrong one here — it duplicated a `docs/` tree that already existed, and nothing checked that the two agreed.

Each README is now what a reader needs in the first minute: what the package is, install with its Node requirement, one working example, and links. The long-form material moved into `docs/` whole — `docs/sdk/architecture.md`, `docs/cli/reference.md`, `docs/packages/<name>.md` — where the doc gates cover it.

Two documentation defects fell out of the move, both in `@namzu/telemetry`'s session-export example, and both had been shipping: the config field is `redactors` and takes a list, not `redactor` taking one; and `secretRedactor` is a factory that has to be called. The required `destination` field was missing from the example entirely. They surfaced because a README is gated by nothing and `docs/` is compiled against the built SDK.

No API change.
