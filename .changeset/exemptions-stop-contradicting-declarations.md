---
'@namzu/cli': minor
---

`save_memory` now asks before it writes

The CLI decided which tools could skip the permission prompt from a
hand-maintained list of names called `READ_ONLY_TOOLS`. Three tools on it —
`save_memory`, `task_create` and `task_update` — declare `readOnly: false` in
the SDK. A constant asserted the exact property it was getting wrong, which is
how the disagreement survived: nothing reading it had reason to doubt the name.

**`save_memory` comes off, and this is the user-visible change.** It writes
content that outlives the run: what is saved now is retrievable by
`search_memory` in a later session, out of `<cwd>/.namzu/memory` inside your own
project. So a tool result or a fetched page that talks the model into saving
something reaches a future run's reasoning. It is not injected into the prompt
automatically — that is `MEMORY.md`, a different thing — but retrievable is
enough. A write that survives the process is not read-only under any reading.

If the agent saves memories often in your workflow, you will now see a prompt
where you did not. Approve-all (`a`) covers the session, and a
`{"permissions": {"save_memory": "allow"}}` rule in `namzu.config.json` covers
it permanently.

**`task_create` and `task_update` stay exempt, honestly labelled.** They are the
model's own plan for the current request, written several times per planning
turn, and prompting each would put a consent dialog between the agent and its
todo list. They now live in a set named `PROMPT_EXEMPT_WRITES` — an override
that says it is one — with the reason recorded per entry, and `/permissions`
discloses them.

**The read-only half is no longer a list of names.** It is each tool's own
`isReadOnly()` declaration, resolved against the live registry at the moment of
the call, so a tool server's tools and the deferred task tools are covered too.
A name list in the consumer is a second source of truth: a new read-only tool
missing from it merely gets prompted, but a *renamed* tool silently changes
posture with nothing to notice.

Two comments claimed these tools "touch only the agent's own `~/.namzu` state".
They write to `<cwd>/.namzu` — the working directory, not the home directory.
Both are corrected.

`/permissions` also now names the built-in safety gate, which hard-denies a
narrow set of catastrophic shell patterns in every mode and which no flag can
switch off. The page claimed to describe what decides a tool call "in the order
it actually decides it" and began one step in; a true-but-incomplete order is
still a wrong order.
