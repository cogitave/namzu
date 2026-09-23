---
"@namzu/cli": minor
---

Delegated work reads more like the reference terminal. Nothing is removed and no key changes meaning; transcripts and screenshots will look different.

- **Launch receipts.** Each batch of agents one response launched now writes one `● Launched 2 agents · <workflow> / <phase> (ctrl+t to manage)` row, with the agents named beneath it as a `├`/`└` tree.
- **Completion rows** read `✓ <name> · 1.7s · 9.0k tokens` or `✗ <name> · failed after 2.9s · <reason>` instead of `<name> · Completed · ctrl+t · agent details`. A completed agent's final answer is attached collapsed; Ctrl+O opens it. The hint is `ctrl+o result · ctrl+t details`.
- **A closing line**, `✻ Worked for 38s · 3 agents`, ends a turn that launched agents. Other turns add nothing.
- **The rail is a borderless tree** under the footer: a `● <workflow> · N running · N queued · ↓ / ctrl+t` header, one `├`/`└` branch per agent, and the running agent's activity on a `⎿` line beneath it on terminals at least 24 rows tall. Tool uses and spend now come before the model. It shows up to three agents on a 30-row terminal where it showed four, because each agent takes two rows there.
- **The rail stays visible while an approval dialog is open**, reduced to its header line. It used to disappear for as long as the dialog was up.
- **One waiting line.** When the parent is only waiting on its agents, the `Waiting · <name>` rows fold into `✻ Waiting for N agents to finish`.
- **The `/effort` picker is a left-to-right slider** on terminals at least 60 columns wide: `default`, the model's levels, then `┆ orchestrate` in violet with `<highest> + delegate by default` under it. ←/→ (and ↑/↓) move it, digits select, Enter applies, Esc goes back. Narrower terminals, and menus too long for one row, keep the vertical list.
- **Orchestrate mode shows on the message box**: the top border carries `orchestrate` in violet on the right, with a still colour gradient where colour is allowed; the footer's `orchestrate` is violet. Below 40 columns the border stays plain.
