---
'@namzu/cli': minor
---

Three new slash commands in the terminal agent: `/cost`, `/permissions` and
`/agents`.

- **`/cost`** — tokens and spend for this run, exact rather than the status
  bar's abbreviation. It states that the figure is cumulative spend and not
  context fill, because those are different quantities and reading one as the
  other is a mistake this codebase has already made once.
- **`/permissions`** — whether an unreviewed tool call is asked about or
  approved automatically, plus the `allow`/`deny` rules from your
  `namzu.config.json`. It also states the precedence, which is the part people
  get wrong in the dangerous direction: a rule decides first, so the bypass flag
  can never reopen what a `deny` closed.
- **`/agents`** — the delegates this session can dispatch to, or a plain answer
  that there are none.

Nothing new is computed. Every figure these print was already produced by the
kernel and thrown away at the edge: usage arrives on the run's own event stream,
the permission rules were compiled before the session opened, and the delegate
roster is decided when the subagent runtime is built. They were reaching the
status bar in abbreviated form, or nowhere at all.

`AgentSession` gains a readonly `agentIds` field so the roster can be reported
rather than rebuilt to find out. It is internal — `@namzu/cli`'s library entry
exports the doctor API, the shell and the config loader, and has never exported
`AgentSession` — so this is additive for consumers.
