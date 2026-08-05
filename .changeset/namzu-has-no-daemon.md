---
'@namzu/cli': minor
---

namzu has no daemon, and stops pretending otherwise

The peer daemon namzu integrated with is deprecated and going away. Everything
namzu built on top of it goes in this release. Four user-facing surfaces
disappear, and one of them is not a command:

- **`namzu tools`** — and its `ls`, `run <name>` and `sync-types` subcommands.
  It inspected and invoked that daemon's tool layer; with the daemon gone there
  is no layer to inspect.
- **`/agents`** — listed the agent peers the daemon knew about, across your
  terminals and its LAN discovery.
- **`/msg <peer> <text>`** — sent a message to another peer's inbox.
- **The inbound channel.** This one had no command, which is exactly why it is
  easy to omit from a list of removals: another agent could put a message in
  namzu's inbox, and a running namzu would surface it, answer it while idle, and
  route the reply back to the sender. That loop is gone. Nothing can send a
  message to a running namzu any more, and a peer that does will get no answer
  rather than an error.

**If your credential came from that daemon's secrets file, namzu will no longer
find it.** It was the second source provider discovery scanned, so a key kept
only there worked with no environment variable set — and the failure now is not
an error message but an absence: the first-run picker opens as though you have
no credential at all. Export it instead (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, …) and namzu finds it again. The picker's empty state and
`namzu doctor` both name the sources that are actually scanned now, so the
answer is available from the command you would reach for when a key stops being
found.

**The agent loses that catalog's ~70 deferred tools** — web search, browser
fetch, sandboxed execution and the rest. namzu runs on the SDK builtins plus its
memory and task tools. The connect line drops its `(+N on demand)` suffix, which
had been counting that catalog and nothing else.

**`namzu serve` keeps its command and changes its answer.** It used to say
coordination came from that daemon, so there was no separate namzu one — the
second half of a sentence whose first half no longer exists. It now states the
other claim outright: namzu has no daemon and no coordination surface, a run is
an ordinary process, nothing needs to be running first. The command stays
because someone typing it deserves an answer, and *unknown command* is a worse
one.

**Config:** the `clawtool` section of `~/.namzu/cli.json` (`binary`, `endpoint`,
`token`, `autoStart`) is gone from `NamzuCliConfig`. It was optional and
zero-config, so a file that never set it is unaffected; a file that did will
have the key ignored.

**No deprecation window, deliberately.** The window exists so working code gets
a release where it still runs and warns. The warning would have to say *migrate
to X*, and there is no X — the thing being integrated with is itself deprecated.
A warning advertising a migration path that does not exist is worse than the
removal, and would need removing itself one release later.

**`minor`, not `major`.** The package is pre-1.0 and promises no stability;
`major` would move it to `1.0.0`, claiming the surface is settled in the same
release that deletes three commands from it. That is the larger untruth.
