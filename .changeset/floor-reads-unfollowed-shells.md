---
'@namzu/sdk': minor
'@namzu/cli': patch
---

A scheduled run can no longer reach the scheduler through a shell the command-line reader does not follow. `powershell -c 'namzu schedule stop'`, `pwsh -command '…'`, `fish -c '…'`, `tcsh -c '…'` and `bash.exe -c '…'` were allowed whatever their text held: the scheduled-run floor took any shell at the head of a command with a `-c` option as read, but only the payloads of `sh`, `bash`, `dash`, `zsh`, `ksh`, `ash` and `mksh` (and `busybox` running one) are. Such text now goes through the floor's tripwire like any other text a program runs as code. A job whose commands use those shells without naming the scheduler, `NAMZU_HOME` or the browser profiles runs as before.

SDK: new exports `nestedShellCommand(words)`, `NESTED_SHELLS` and the type `NestedShellCommand`. `nestedShellCommand` says, for one simple command's words (without its leading assignments), which `-c` payload `lexShellCommandLine` reads as a command line of its own, why it made the line opaque instead, or `null` when it reads none. The lexer uses it itself, so its reading is unchanged.
