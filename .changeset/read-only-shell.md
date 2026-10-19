---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Read-only shell commands no longer ask. `ls`, `cat`, `head`, `wc`, `git status`, `git diff`, `git log`, `git show` and the rest of the reference terminal's vetted list run without a prompt in `prompt` and `accept-edits`, are allowed in `plan`, and run beside other read-only tool calls instead of one at a time. Anything the list does not vouch for still asks: a write redirection, a `$variable`, a substitution, a subshell, a here-document, a glob on a command that is not a plain reader, `cd` next to `git`, and any git flag outside the vetted table (`--output`, `-c`, `--exec-path`, `--config-env`, `fetch`, `commit`, branch or tag creation).

What changes for you: a turn that used to stop at `git status` now runs it. A read-only command that reads outside the working directory and added directories is still asked about, and so are protected paths and catastrophic removals. If you embed the SDK and rely on `bash` never being exempt from review, a host that wants the old behaviour passes its own `isReviewExempt` that returns false for `bash`.

New in the SDK: the builtin `bash` tool answers `isReadOnly` and `isConcurrencySafe` per call from the command line, and `DefineToolOptions.concurrencySafe` may be a function of the input, as `readOnly` already was.
