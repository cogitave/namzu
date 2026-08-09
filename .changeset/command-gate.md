---
'@namzu/sdk': minor
'@namzu/cli': minor
---

`--gate '<command>'` — a run that is not allowed to finish on a red build

`reviewAnswer` shipped complete: consulted only when the model stops calling tools, never on the forced-final turn, bounded by a rejection budget, with its own terminal state `answer_rejected` so a stop is not mistaken for a token budget running out. **No shipped app supplied one**, so an operator could not use any of it without writing TypeScript.

New in `@namzu/sdk`: `createCommandGate({ commands, cwd, maxRetries?, timeoutMs?, exec?, maxOutputChars?, fingerprint? }): ReviewAnswer`. It runs shell command lines in order, stops at the first failure, and hands the failure back as the next user turn naming the command, the attempt, the exit code and a head-and-tail clip of the output.

New in `@namzu/cli`: a repeatable `--gate '<command>'` on `run` and `run-stream`, plus `--gate-retries <n>`. Repeating the flag appends rather than replaces — `--gate 'pnpm typecheck' --gate 'pnpm test'` means both, in that order.

**The part that makes it a bounded loop rather than one that burns its budget.** Before re-running a command that already failed, the workspace is fingerprinted; if it is byte-for-byte identical to the snapshot taken when that command last failed, the command is **not run**. The attempt still advances and the model is told the workspace has not changed and must edit something before trying to finish — cheaper than a full test run, and a *different* instruction from repeating a failure it has already been shown.

Also new and exported: `fingerprintWorkspace({ cwd, exec, timeoutMs?, maxBytes?, fs? })`. It hashes `git status --porcelain`, `git diff --binary HEAD` and the contents of every untracked file, **recording a symlink as its target rather than reading through it** — a link repointed to a different file with identical bytes is a change, and following it would hash the two the same.

It returns `null` — meaning *no fingerprint* — for a non-zero git exit, a tree with no commits, a timeout, or output past the size cap, and a caller that cannot fingerprint re-runs its command. That direction is deliberate: a wrong `null` costs one execution, while a wrong match is a verification that silently did not happen.

A run with no `--gate` is byte-identical to one from before this existed: the option is spread in only when gates were asked for.
