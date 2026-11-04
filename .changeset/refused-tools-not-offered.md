---
'@namzu/cli': patch
---

`namzu exec` no longer offers a tool you refuse by name. `--disallowed-tools web_fetch,web_search`, or `web_fetch = "deny"` in any permission layer, used to leave the tool in every request and the "Using the web" section in the system prompt, so the model kept calling it and each call came back refused. Now the tool's definition and its guidance are left out, as they already were in a scheduled run. A pattern entry such as `bash(rm *)` is unchanged: the tool stays, and the matching calls are refused. The interactive session is unchanged too, because its permissions can change while it runs. Nothing to do on your side; if you relied on the model being told a tool exists but is blocked, allow the tool or say so in the prompt.
