---
"@namzu/sdk": major
"@namzu/cli": major
---

Add the explicit `cmd` ShellDialect and change the native Windows host-shell metadata default from `sh` to `cmd`. The physical command shell remains Node's platform shell (normally CMD); no PowerShell or WSL switch occurs. Update exhaustive dialect handling to include `cmd` and pass the actual value to authorization helpers.

CMD lines are conservatively opaque until a matching parser exists. Command-specific allow rules and skill patterns no longer pre-approve native CMD commands. The existing unknown-program escalation still requires exact-call review, even when the gate has a whole-tool allowance. Use that review or explicitly select a POSIX interpreter rather than incorrectly labelling CMD as `sh`. Sandboxed Linux guests retain `sh`.

SDK query prompts disclose the active command tools' host or guest execution dialect, including minimal and cached prompts. Explicit Windows `bash.exe` and `sh.exe` overrides retain their matching POSIX dialects.

Native Windows CLI model shell calls inherit the exact-call review requirement. The scheduled-run floor refuses CMD commands rather than checking them with POSIX quoting; confirmed script jobs still accept only explicit bash/sh interpreters. Use an installed POSIX interpreter where appropriate or run reviewed interactive CMD calls.
