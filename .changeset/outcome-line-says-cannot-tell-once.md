---
'@namzu/cli': minor
---

The line under a finished turn that said "A command ran that may have changed files · cannot tell" no longer repeats under every turn in a folder that Namzu cannot watch for changes. The first turn of a conversation that gets it now says "A command ran that may have changed files · cannot tell here · not repeated in this conversation" (naming the reason when the tools work in a separate copy of the folder), and later turns add nothing. Every other line is unchanged. A resumed conversation now shows the outcome lines of its past turns too, which it did not before, with the same once-only rule. `exec` JSON output, the Desktop feed and the delegation line still carry the verdict for every turn. A script that matches the old terminal wording will no longer find it.
