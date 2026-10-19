---
"@namzu/sdk": minor
"@namzu/cli": minor
"@namzu/ag-ui": patch
---

Three safety floors follow the reference terminal, so a turn in `auto` (`--yolo`) now stops and asks where it used to run silently. No exported name, option or default value changes; `ToolCallEscalation` gains two optional fields (`protectedPaths`, `dangerousRemoval`).

What changes for you:

- **Writes to protected paths are asked every time, in every mode.** `write`, `edit`, a shell redirection (`>`, `>>`, `tee`) and the operands of `cp`, `mv`, `touch`, `mkdir`, `rm`, `rmdir` and `sed -i` are asked about when they land in `.git`, `.vscode`, `.idea`, `.husky`, `.cargo`, `.devcontainer`, `.yarn`, `.mvn`, `.config/git`, `.namzu`, or on a shell startup file, `.gitconfig`, `.envrc`, `.npmrc`, `namzu.config.json` and the other names in `authorization/protected-paths.ts`. A rule that allows the tool, `auto`, and an earlier "approve all" do not cover it. With nobody to ask (`namzu exec`, a drained turn, a scheduled run) the batch is refused. To make a change there, make it yourself, or answer the prompt.
- **A catastrophic `rm` or `rmdir` is asked every time.** The check reads the targets whatever the flags (`-fr`, `-r -f`, `--recursive --force`): `/`, a top-level directory, `~`, `$HOME`, `..`, the working directory or a parent of it, a glob across directories, `"$VAR/"` (empty means `/`). The old `rm -rf /` pattern in the dangerous-command floor is kept, so that spelling is still denied outright rather than asked.
- **A shell command's own paths are checked against the working directory.** On a turn that reviews outside paths (the CLI does), `cat /etc/passwd`, `ls ~/.ssh` and `echo x > ~/.profile` are now the same approval request a `read` outside the project is, instead of passing because `bash` declares no path argument.

If you embed the SDK with your own resume handler, read `ToolCallSummary.escalation.protectedPaths` and `.dangerousRemoval` the way you read `outsidePaths`; `createReviewHandler` does it for you. If your turn runs `bash` with no one to ask and relies on `auto`, expect those calls to be refused with a reason the model can act on.
