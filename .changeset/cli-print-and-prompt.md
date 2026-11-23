---
'@namzu/cli': minor
'@namzu/desktop': patch
---

`namzu "<prompt>"` starts the interactive session on that first message, and `namzu -p "<prompt>"` answers a prompt and exits, running exactly what `namzu exec "<prompt>"` runs. With `-p` the root takes exec's options with the same meaning (`--output-format text|json|stream-json`, `--input-format`, `--max-budget-usd`, `--mcp-config`, `-c`, `-r <id>`, `--model`, `--provider`, `--permission-mode`, `--allowed-tools`, `--disallowed-tools`, `--append-system-prompt`, `--no-session-persistence`, `--fallback-model`, `--max-output-tokens`, `--effort`) and reads piped input as exec does; `namzu exec -r <id>` now means `--resume <id>`. A prompt that begins with a dash or is a command name goes after `--`: `namzu -- "providers"`.

Without `-p`, `--output-format`, `--input-format` and `--max-budget-usd` are refused with one line saying they need `-p` (exit 64); before this, `--max-budget-usd` was refused with a line pointing at exec. `--message` still works, hidden from `--help`, because builds already installed pass it; write `namzu "<text>"` in anything new. Nothing to change in scripts that call `namzu exec`. Desktop's terminal tab now starts Namzu with the composer's text after `--`.
