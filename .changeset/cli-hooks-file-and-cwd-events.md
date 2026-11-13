---
'@namzu/cli': minor
---

A hooks block can now name `file_changed` (`FileChanged`) and `cwd_changed` (`CwdChanged`). `file_changed` watches the files its matcher names (`.envrc|package.json`) and any a hook hands back with `watchPaths`, firing once per burst of writes; nothing is watched when no hook asks. `cwd_changed` fires when a shell command leaves the next one in another folder. A hook on `session_start`, `cwd_changed` or `file_changed` is started with `NAMZU_ENV_FILE` and can append `export NAME=value` lines that become the environment of the shell commands that follow, sub-agents included (loader, shell start-up and `NAMZU_*` names are refused; `PATH` is allowed). `/hooks` lists the variable names set and the files watched; a hook's `systemMessage` is shown in the transcript or on stderr for `namzu exec`. Nothing changes for configs that use neither.
