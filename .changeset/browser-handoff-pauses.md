---
'@namzu/sdk': patch
---

A `browser_human_required` refusal from a browser host now pauses the turn. The browser tools set `ToolResult.handoff` (`reason` in words such as `https://github.com is showing a sign-in page`; `detail` carries `tool: 'browser'`, `cause`, `origin`, `profile` and `loginCommand`) as well as `data.handoff`, so the kernel stops before the next model call and waits for the person, as it does for any tool handoff. Before this, the model read the refusal and carried on. Nothing changes for other refusals.
