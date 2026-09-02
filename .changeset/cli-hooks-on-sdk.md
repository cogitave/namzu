---
"@namzu/cli": patch
---

Shell hooks now run on the kernel's adapter. The `hooks:` config key, its shape and its behaviour are unchanged; the CLI only reads the file and hands the table to `@namzu/sdk`'s `attachShellHooks`, so an ACP server or an embedder gets the same contract from the same code.
