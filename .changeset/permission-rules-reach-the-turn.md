---
'@namzu/cli': minor
---

a permissions rule you wrote is the one that runs

A `permissions` table in a config file did nothing. Not in `namzu run`, not in
`run-stream`, not in the interactive TUI — nowhere, since the table was
introduced. Three faults in series, each sufficient on its own:

1. **The loader dropped it.** `sanitize()` copied exactly `format` and `quiet`
   off a parsed config file, so `permissions` never survived being read.
   `compilePermissions(ctx.config.permissions)` had always been compiling
   `undefined`.
2. **The turn discarded it.** The top-level turn passed a module-level gate
   whose `rules` is a hardcoded empty array, so even a caller handing rules in
   explicitly had them dropped. The helper that folds them in was called on the
   sub-agent path only.
3. **The TUI never asked for it.** Only `run` and `run-stream` compiled the
   table at all, so interactive sessions had no rules to drop in the first
   place.

**Nothing looked broken, and that is the worst part.** The gate already falls
back to asking, and `ask` compiles to no rule — so a discarded `deny` is
indistinguishable from a config that was honoured. You are prompted, you
approve, and you never learn your refusal was thrown away. A visible failure
would have been found in a day.

**What changes for you:** if you have a `permissions` table, it now applies. A
`deny` refuses instead of prompting, and an `allow` stops asking. Check yours
before upgrading — it has never actually run, so this is the first release in
which it means anything. In an interactive session a `deny` is not even
offered for approval, which is the point of writing one.

Adding a field to the config type now fails to compile until the loader is
taught to read it. The old code ended in `out as NamzuCliConfig`, and that cast
is precisely what let `permissions` be declared, documented, type-checked and
ignored; the loader's field list is now derived from the config type instead of
restated beside it.

Also documents where the config file lives and what it looks like, which was
written down nowhere.

`minor`, not `patch`: a table that was inert becomes active, so a `deny` you
forgot you wrote can stop a command that used to run. Nothing about the API
changed, but the behaviour a consumer sees does, and that is what the bump is a
claim about.
