---
type: Reference
title: Print mode and the prompt argument
description: namzu "<prompt>" starts the interactive session on a first message, namzu -p "<prompt>" answers it and exits as namzu exec does, which options -p takes, how piped input is read, and the print-only options refused without -p.
resource: packages/cli/src/cli.ts
tags: [cli, exec, headless]
status: stable
generated: { by: human:bahadirarda, at: 2026-11-23T00:00:00Z }
---

# Print mode and the prompt argument

`namzu [options] [command] [prompt]`: a word that is not a command name is the prompt.

```sh
namzu "fix the failing test"        # opens the session on that first message
namzu -p "fix the failing test"     # answers it, prints the reply and exits
echo "why does it fail" | namzu -p  # piped input is the prompt
cat build.log | namzu -p "what broke?"
```

## The prompt

Without `-p` the prompt is the first message of the interactive session, sent once as a plain prompt ([Launch flags](launch-flags.md)). A command name always wins over a prompt; a retired command name prints the line saying what replaced it. After `--` everything is the prompt, so `namzu -- "providers"` and `namzu -- "-x is a flag"` work.

## `-p`, `--print`

`namzu -p "<prompt>"` runs exactly what `namzu exec "<prompt>"` runs: the same handler, the same exit codes ([exec exit codes](exec-exit-codes.md)), the same stdin rules (piped input is the prompt, or material beside it). With `-p` the root takes the options of `namzu exec` with the same meaning, among them:

| Option | Meaning |
| --- | --- |
| `--output-format text\|json\|stream-json` | the reply, one result object, or an event per line ([exec --json](exec-json.md)) |
| `--input-format text\|stream-json` | how piped input is read |
| `--max-budget-usd <n>` | stop when the priced spend reaches n dollars |
| `--mcp-config <file>` | add tool servers for this run |
| `-c`, `--continue`; `-r`, `--resume <id>` | carry on an earlier conversation |
| `--model`, `--provider`, `--effort`, `--fallback-model` | what answers |
| `--permission-mode`, `--allowed-tools`, `--disallowed-tools` | what may run |
| `--append-system-prompt`, `--system-prompt`, `--tools`, `--max-output-tokens`, `--no-session-persistence` | per-run settings ([Launch flags](launch-flags.md#shaping-one-launch)) |
| `-n`, `--name`; `--mcp-config`, `--strict-mcp-config` | name the conversation; choose tool servers |
| `--bare`, `--settings`, `--debug-file` | minimal run, one more settings layer, a debug log file (read by the root, so they work before or after the prompt) |

Every other option `namzu exec` reads works the same after `-p`. `-f/--format`, `-q`, `-v`, `--debug` and `--log-format` stay root options. The options that only shape an interactive session are not read by `namzu exec`, so `-p` refuses them as unknown options: `--profile`, `--add-dir`, `--plugin-dir`, `--fast`, `--no-done-gate`, `--from-pr` and `--allow-dangerously-skip-permissions`. `namzu exec` is unchanged and is what scheduled jobs, workflow files and Desktop call.

## Print-only options without `-p`

`--output-format`, `--input-format` and `--max-budget-usd` mean nothing in the interactive session. Without `-p` they are refused in one line (`--output-format needs -p: ...`, exit 64). After a subcommand they belong to that subcommand.
