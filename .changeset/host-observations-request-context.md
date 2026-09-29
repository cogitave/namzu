---
'@namzu/sdk': major
'@namzu/cli': major
---

Plugin `user_prompt_submit` annotations now reach the model as user-role request context instead of system instructions. The CLI gives operator shell output and idle background-job exits the same request-context role. Hosts that used these observation channels to issue policy must move that policy to an explicit trusted instruction; the observations remain visible to the model on the current request.

The `namzu mcp test` HTTP 401 hint now uses a literal `<name>` placeholder instead of embedding the configured server name in a runnable shell command.
