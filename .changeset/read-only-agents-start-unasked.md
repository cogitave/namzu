---
"@namzu/cli": major
---

**Read-only agents start without asking in `prompt` mode.** An `Agent` call that starts `explore`, or an agent file with `readOnly: true`, on the session's own provider and model no longer opens the "Start an agent" review in `prompt` or `accept-edits` mode, and `plan` mode now lets it start instead of refusing it. Every call such a child makes is still reviewed as before, and its roster still has no tool that writes.

Still asked about: a general-purpose agent, an agent file without `readOnly: true`, a read-only agent given `provider`, `effort` or a `model` other than the session's, an agent file that names another model, and any batch that includes one of those. `strict` still refuses every launch no rule allows.

What breaks: a `prompt`-mode operator who relied on seeing and declining each `explore` launch is no longer asked, and a `plan`-mode turn can now start read-only agents.

To keep the old behaviour — every launch asked about in `prompt` and `accept-edits`, refused in `plan` — add an `ask` rule for the tool:

```json
{ "permissions": { "Agent": "ask" } }
```

in `namzu.config.json` (or `permissions: { Agent: ask }` in `~/.namzu/config.yaml`). An `ask` rule is an explicit review, which the read-only exemption never skips. `/permissions details` says which rule is in force.
