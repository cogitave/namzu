---
'@namzu/sdk': minor
'@namzu/cli': minor
'@namzu/desktop': patch
---

New setting `permissions.outsideRoot: ask | refuse` for the file tools (`read`, `write`, `edit`, `glob`, `grep`, `ls`, and any tool that declares a path argument, such as `view_image`, `lsp`, `code_analysis` and `browser`). The default, `ask`, is unchanged: a path outside the working directory and the added directories is put to you. With `refuse` it is refused without asking, in every mode including bypass and auto, and the message names the setting and `--add-dir`. Any config file may set it, and a `refuse` in one file is not undone by another, so a project file can only make it stricter. It is also a choice in Desktop Settings, which asks only when you choose `ask`. Sub-agents get the same refusal and the same sentence. Shell command operands and redirections are still asked about; that is a later change. SDK: `QueryParams.outsideRootRefusal` lets a host choose the sentence the model reads when `outsideRootAccess` is `'refuse'`; without it nothing changes.
