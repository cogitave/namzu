---
"@namzu/sdk": minor
"@namzu/cli": patch
"@namzu/desktop": patch
---

A tool result can now say what the call did as typed fields, so a host builds what a person sees from fields and not from the model's text. Nothing you already send or receive changes shape, the text the model reads is unchanged, and no code needs to change to upgrade.

New and optional: `ToolResult.facts`, a closed union (`ToolFacts`) of a command's exit code and its stdout and stderr as head-and-tail windows (`ToolTextWindow`) or a note that the output was binary, a read's path and size, a search's and a listing's counts, whether a write created, updated or left a file, and the kind of a failure (`ToolFailureReason`). The built-in `bash`, `read`, `grep`, `glob`, `edit` and `write` tools set it, `tool_completed` and the ACP `tool_call` update carry it, a generic `ToolCallView` may carry `facts` for what the call is about, and `admitToolFacts` reads a saved one back. A call refused without running, an unknown tool and a thrown filesystem error also carry a `failure` fact. `execHostShell` additionally returns `stdoutBytes` and `stderrBytes`. A post-tool hook that replaces the output also drops `facts`, so a redaction is never undone.

If you build a view of tool output yourself, read these fields instead of the `STDOUT:` and `STDERR:` labels, the "Found 2 match(es)" and "1 replacement(s)" sentences and the notes about withheld credentials or shortened output, which are the model's interface and are not stable text to parse.

The Desktop app now words every tool row from those fields (Read a.ts, Searched for export, Ran npm test · failed (exit 3), Couldn't read missing.txt: file not found), draws a command's colours, folds long output to its first and last lines with Show more, says "Binary output, 3 KB" instead of printing the bytes, counts a finished edit in the reply's changes card, shows paths in approvals relative to the project, and leaves "0s" off work that took under a second. The CLI host restores a saved conversation's `facts` (without a command's output) so a reopened row reads the same.
