# CLI

The operator application.

* [Context and compaction in the CLI](context-and-compaction.md) - The file-only compaction key that picks the kernel's strategy or overrides the model's window, and the /context command that shows what compaction has done in a session.
* [Where the CLI stands against its peers](competitive-gaps.md) - What `Claude Code`, `Codex CLI`, `Gemini CLI` and `OpenCode` offer that namzu does not, what namzu does better, and the backlog that follows.
* [Adding a directory](add-dir.md) - How a session lets the file tools reach a directory besides the working directory, and what changes for the tools, the sandbox and the model.
* [File checkpoints](file-checkpoints.md) - How the session records every file before a tool changes it, per turn, and how /restore puts the tree back to before a turn.
* [Run limits](run-limits.md) - How far one headless run may go before the kernel stops it: the limits config key and the --max-iterations and --token-budget flags.
* [Slash commands](slash-commands.md) - Every builtin slash command the interactive session answers to, one line each, with the composer keys that are not commands.
* [The composer prefixes](composer-prefixes.md) - What a line starting with `!` or `#` does in the composer: a command run on the host without the model, or a note remembered, and what the model learns of either.
* [Background jobs in the CLI](background-jobs.md) - How a command started with run_in_background outlives its turn, how the model and the operator learn that it ended, what /jobs shows, and why a sandboxed session has none.
