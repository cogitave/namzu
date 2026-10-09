---
"@namzu/cli": minor
---

`namzu acp --desktop` gains the host method `namzu/harnesses/release`, which takes an `engine` (`codex-cli` or `claude-code`) and ends the idle engine servers the connection keeps for it, answering `{ released: true }`. It never touches a conversation that is running; it only closes the Codex app-server that model discovery parked, so a client can replace the engine's program on disk (a running executable cannot be overwritten on Windows) before it updates it. The Desktop uses it before running an engine's update command. A client that never calls it sees no change, and a host that predates the method answers `-32601`, which the Desktop treats as "nothing to release".
