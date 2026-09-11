# Native Windows CLI verification — 2026-09-11

The earlier isolated permission-function test missed the directory hierarchy used
by the application. Running the packaged CLI in a native Windows terminal found
a second startup failure: `projects/<id>/cli` contained an explicit `BA` grant.
The parent had a current-user grant that did not propagate to children; Windows
created descendants using the process token's default ACL.

The fix grants the current account `(OI)(CI)F` on directories, and removes the
Administrators grant from the named directory being secured. The validator still
rejects that group, other users and broad groups. This is a tightening operation,
not a new group allowance. Files keep their existing validation. Existing child
files with explicit ACLs are not recursively migrated.

## Application tests

Eleven current workspace packages were packed and installed together by native
npm into a temporary Windows consumer directory. Dependency lifecycle scripts
were disabled for this test installation. Global installations were unchanged.
The actual `@namzu/cli/dist/bin.js` ran with native Windows Node v22.20.0, through
the npm-generated launchers in PowerShell 5.1 and Git Bash. Git for Windows
`winpty` supplied native terminal input and output; both reported TTY support.
This did not use the Linux CLI or an Ink mock renderer.

Each shell used its own temporary `NAMZU_HOME` and a small test project. Existing
provider sessions were discovered by the application; no new sign-in was done.
No credential values or user documents are included in the
[recorded evidence](results/2026-09-11-tui.json).

| Check | Observed result |
| --- | --- |
| PowerShell launch before inheritance fix | Refused the generated directory's `BA` grant |
| Reopen the same failed state after the fix | Composer ready; existing subscription discovered |
| PowerShell `/status` | Version, provider, model and workspace displayed |
| Small Anthropic/Haiku request | HTTP 429 with a displayed retry delay of about 22 hours; generation did not succeed |
| Git Bash fresh trust and startup | Composer ready with the existing subscription |
| `/model zen/muse-spark-1.3-contributor-free`, then `/effort low` | Both controls applied through the TUI |
| Read only the test `notes.txt` | One successful read, exact `SILVER-482` marker returned; file unchanged |
| Exit and resume that conversation | Original prompt and answer restored, with no new model call |
| Process exit | All three TUI invocations exited cleanly after Ctrl+C confirmation |

The free-model task used two model responses and 19,645 provider-reported tokens.
This is a functional smoke test, not a speed or cost benchmark. The subscription
request reached the service but was quota-limited; it establishes neither a
successful paid-model generation nor a new login/refresh flow.

Direct `/model <ID>` and `/effort` choices currently last for the TUI invocation.
Resume selected the saved startup default, while retaining the conversation's
messages. The test does not claim durable restoration of that temporary model
and effort choice.

## Reproduction and remaining boundaries

[check-installed.mjs](check-installed.mjs) runs against an already installed
Windows consumer, exercising its actual permission helpers and CLI commands in
fresh temporary state. It makes no model requests. Run it with native Windows
Node and the absolute consumer directory as its first argument. The
[installed-package results](results/2026-09-11-installed.json) supplement the
earlier [source-module test](check-native.mjs).

The TUI steps above require explicit live execution and an available provider
session. Type slash-command text and Enter as separate key events. The automated
driver's combined input chunks are not equivalent to separate keyboard events.
No publication, global upgrade, provider installation, arbitrary workspace test,
or comprehensive Windows compatibility claim follows from this smoke test.

The separate [npm launcher tests](../windows-npm/results/2026-09-11.json) cover
native setup/upgrade process launching and cancellation using a synthetic npm
entry point. They do not install or upgrade a real provider application.
