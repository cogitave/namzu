---
'@namzu/cli': minor
---

Preferences hold an ordered chain of providers, not one

`~/.namzu/preferences.json` now stores `providers`, an ordered list, in place of
the single `provider` + `model` pair. Index 0 is the primary and is what runs.

**Nothing is required of you.** A `version: 2` file is read as a one-member
chain — one provider is a one-element list, which is unambiguous — and is
rewritten in the new format the next time a choice is saved. A `version: 1` file
is still refused, as before. Downgrading namzu after a chain has been written
reports "please re-pick" rather than silently dropping the members it cannot
represent.

**Only the primary runs today.** Automatic failover is a separate change; this
one is the configuration it will read. Declaring a longer chain is still worth
doing now, because the whole of it is checked:

- Every member must name a provider namzu knows, **including members after the
  first**. A fallback that names a provider that does not exist used to load
  fine and fail at construction — on the day the primary went down, which is the
  worst moment to discover it.
- A member may not repeat an earlier one exactly. The same provider with a
  *different model* is allowed, and is a real chain: a large model falling back
  to a smaller one.
- The chain may not be empty.

A rejected chain names the position that broke it (`primary provider`,
`fallback #1`, …) and re-opens the picker.

`namzu doctor` gained `providers.chain`, which prints the chain in your declared
order with each member's credential state, so the order is legible without
launching the TUI. A fallback with no credential is a warning; a primary with
none is a failure.

`namzu run --provider <id>` now **replaces** the chain for that run rather than
re-heading it, so a run you scoped to one provider cannot be answered by a
different one. `--model` on its own re-models the primary and leaves the rest of
the chain in place. Neither changes what a single-provider setup does today.

Adds the `providerChainCheck` export for embedded consumers assembling their own
doctor registry.

`namzu doctor` also indents every line of a multi-line check message. Previously
only the first line took the report's indent and the rest broke out to column 0,
so a multi-line answer read as though the report had ended.
