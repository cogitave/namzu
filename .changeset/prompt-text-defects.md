---
"@namzu/cli": patch
---

Namzu's opening instructions no longer point the model at a shell tool called `bash.run` (it never existed; the tool is `bash`), no longer carry a closed list of six tools, and say one consistent thing about parallel work: independent tool calls may share a response, `bash` calls run one at a time, and the model does not claim concurrency without proof. The foreground `bash` tool's description no longer steers shell work through a sub-agent. The environment paragraph about permissions now follows the turn's permission mode instead of saying every call may ask the user, and says a call that would ask is refused when nobody is at the terminal. Nothing to do on upgrade.
