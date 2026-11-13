---
'@namzu/cli': minor
---

A skill can carry its own hooks: a skill written to check every command it runs, or to format every file it writes, keeps that check. Nothing is removed or renamed.

What you can now do:

- Put a `hooks` block, in either shape (ours or the common hook contract's), in a skill's `SKILL.md` front matter. It is read by the reader the config files use, so problems read the same. The hooks attach when the skill is used (the model loads it, or you run it with `/skills <name>`, `/<name>` or `--skills`), last for the rest of the conversation, and end with `/clear`, a resume, a fork or leaving. A skill that sets `context: fork` attaches them to its agent's run only. `once: true` removes an entry after its first run. The command gets `NAMZU_SKILL_ROOT` (the skill's folder), and `${NAMZU_SKILL_ROOT}` in `command` and `args` is replaced by it.
- See them: `/hooks` lists a skill's attached hooks with its name and says which skills carry hooks that attach when used; `namzu doctor` (`runtime.hooks`), `namzu skills --audit` and `namzu plugin validate` (`skill-hooks-problem`) name what in a skill's hooks cannot be loaded; the trust prompt lists the hooks the folder's skills carry.
- Switch them off: `disableHooks`, `NAMZU_DISABLE_HOOKS=1` and `hooksManagedOnly` stop them, and the skill then loads as if it had no `hooks` key (its `allowed-tools` pre-approval stays). No skills place is managed, so under `hooksManagedOnly` none run.

What to know: a guard that cannot be loaded is not a skill that runs unguarded. If an entry on an event that can refuse a call or a turn cannot be loaded, the skill still loads without its tools pre-approved, the entries that could be read are still attached, and the model and you are told why in one line. If the block is not YAML, has more than 32 entries, or has a `matcher` or `if` over 256 characters, none of its hooks attach. An entry on another event, or an event this kernel does not have, is dropped with a note. A skill in the project folder cannot attach hooks while the folder is not trusted.

What to do: a skill of yours that already had a `hooks:` block written for another tool was ignored until now; it runs when the skill is used, so read it first. The Desktop app's trust dialog does not list skill hooks yet.

Also: a hook event written at the top level of the front matter (`PreToolUse:` beside `name:`) is read as if it were under `hooks:`; a forked skill's hooks follow the agent that received the skill's prompt, not whichever agent started first; a skill's `session_start` entry is set aside with a note, since it can never fire; the hooks end with the conversation, so after a resume load the skill again.
