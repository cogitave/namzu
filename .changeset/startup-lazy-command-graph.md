---
"@namzu/cli": patch
---

`namzu --version` and `namzu --help` answer in about 50 ms instead of about 480 ms. The command shell no longer imports every command and `@namzu/sdk` before it parses the command line; each command's module is imported when the command runs. Help text, option choices, exit codes and the output of every command are unchanged (the root help and every subcommand's `--help` were diffed against the previous build).

Anything that imported `emitBootNarrative` from the package's internal `cli.js` now finds it in `boot-narrative.js`; it was never part of the package's exports.
