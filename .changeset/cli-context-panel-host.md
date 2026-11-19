---
'@namzu/cli': minor
---

The desktop host (`namzu acp --desktop`) answers a new request, `namzu/session/context` (`sessionId`, optional `detail` of `summary` or `full`), with where a conversation's context window goes: the categories with their sizes, the reserve, the free space, the sizes of tools that load only when needed, who counted the total, and on `full` the tool server tools, skills, agents and project notes by name and size (no contents). It answers `null` before the engine has reported a window. Other clients are unaffected; a host that does not list the method simply has no panel in Desktop.

`/context` in the terminal now shows the reserve on every window while automatic shortening is on (33,000 tokens on a 200,000-token window), so its Free space line is smaller than before on a window the provider declares, and lists tools that load only when needed as dim lines after the categories. Nothing to do; this is a correction of what the numbers show.
