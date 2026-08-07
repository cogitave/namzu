---
'@namzu/cli': major
---

Removed the `namzu providers` command and its five subcommands (`ls`, `add`,
`remove`, `default`, `path`), along with the `~/.namzu/providers.json` profile
store behind them.

**What breaks.** `namzu providers add …` and its siblings no longer exist. If a
script calls them it will now fail with an unknown-command error instead of
succeeding.

**Why this is a fix and not a regression: the profiles were never used.** The
run path resolves credentials through `discoverProviders`, which reads
environment variables, the macOS Keychain, and local probe URLs. It never read
`providers.json` — `readProfiles` and `resolveApiKey` had exactly one importer
between them, the `providers` command itself. So `providers add` wrote a file,
printed `added profile "<name>"`, exited 0, and the credential was never
consulted by a single run. The store's `~/.namzu/providers.json` file is now
inert; you may delete it.

The failure was worse than an unused file, because two shipped commands
disagreed about your credentials: `providers ls` reported a key with
`source: file` while `namzu doctor` reported no credentials at all, since they
read different stores.

**What to do instead.** Set the provider's environment variable — the same one
you already set for anything else:

```bash
export ANTHROPIC_API_KEY=sk-ant-…    # or OPENAI_API_KEY, OPENROUTER_API_KEY
```

This is what the run path, the TUI picker and `namzu doctor` have always read,
and they agree with each other. On macOS an Anthropic OAuth credential in the
login Keychain is also picked up automatically. To see what is detected, use
`namzu doctor` or `namzu providers-json` — the latter is a different, live
command that is not affected by this removal.

**Why removal rather than wiring it up.** The command's own header declared it
an unfinished milestone: *"Live provider instantiation … is M3 work and not done
here; M2's job is purely store + retrieve + display."* That wiring never
arrived, and finishing it is a feature rather than a fix. The gap was also far
wider than the credential: `providers add` accepted seven `--type` values while
the run path can register four (`bedrock`, `http` and `lmstudio` throw
`provider "<id>" is not wired yet`), and it accepted nine options of which the
detection model has fields for two. Wiring only the API key would have left a
command whose success message was still mostly false.

Nothing documented it — no page under `docs/`, no README — so no documented
promise is broken by its removal.
