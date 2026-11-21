---
'@namzu/cli': minor
---

`namzu login claude` now works from a shell that cannot take a paste (a chat tool's shell, a script). When standard input is not a terminal and closes, the command no longer fails: it keeps the sign-in for 10 minutes in an owner-only file under the Namzu home (`login-pending/anthropic.json`, never printed), prints the address, and exits 0 meaning "waiting for the code". Finish with `namzu login claude --code <code>`, where the value is the bare code, `code#state` or the finished address. A missing, expired or state-mismatched sign-in is refused in plain words. A script that treated exit 0 as "signed in" should check for the stored credential or run `--code` before relying on it. The interactive terminal flow and the Codex sign-in are unchanged.
