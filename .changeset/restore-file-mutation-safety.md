---
'@namzu/sdk': patch
---

Restore the file-mutation safety that 3.0.0 reverted.

Reconciling a long-running branch with `-X ours` resolved conflicts in the branch's favour, and the branch had been cut before four hardening commits landed on `main`. The result shipped: `edit.ts` and `write-file.ts` went out byte-identical to their shape from before that work, and both modules it depended on were left in the tree with zero importers.

What came back, with a test that fails without it:

- **Crash-atomic commits.** Both tools wrote with a bare `writeFile`, so a failure partway through left the destination truncated — the user's own file, in the tool that exists to avoid exactly that. They commit through `atomicWriteFile` again (temp file beside the destination, fsync, rename).
- **Same-path serialization.** Two concurrent edits to one path interleaved their reads and the second write landed on content the first had already replaced, so one edit vanished and the loser reported `old_string not found` — blaming the model for a race. `withFileMutationLock` wraps both the sandbox and local branches again. For `write`, the lock also closes the gap between the exists-check and the write, which is a check-then-act pair.
- **Closed input contracts.** `.strict()` was gone, so zod's default silently STRIPPED an unknown key: a misspelled or hallucinated field became a no-op instead of an error. `edit`, `write` and `ask_user_question` reject the unknown again — while still accepting the `oldStr`/`newStr` aliases and `insertLine`, which are declared. Closed is not the same as narrow.
- **`modelInputSchema` and `enforceModelInput`.** The model-facing schemas are back, and so is the producer: `enforcedModelInputToolNames()` had been deleted, so **nothing** populated `enforceToolInputSchema` and all three drivers that read it were reading a permanently undefined field.
- **CRLF/LF reconciliation**, so an `old_string` that is right in every visible way still matches a file whose line endings differ.

Also fixes `atomicWriteFile` on Windows, where it had never run: it fsyncs the directory after the rename, which that platform refuses with `EPERM`, and the error was not caught — so every atomic write failed after correctly writing the file. That sync is best-effort now, and only after the commit has already landed.
