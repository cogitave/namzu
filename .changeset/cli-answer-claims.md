---
"@namzu/cli": minor
---

When an answer says a check passed (tests, build, lint, type checking) and the same turn's record says a check failed, or says files changed and no check ran or none could be read, the terminal now shows one more line under the outcome line: "The answer says the tests pass. The record: pnpm test failed." Nothing is shown in any other case, and nothing is blocked or sent back to the model. `namzu exec --output-format json` and the `done` line of `exec --json` gain an optional `claimMismatch` key with the same facts, absent when there is none; a script that reads only the keys it knows is not affected. English claims only; a reopened conversation does not show the line.
