---
'@namzu/cli': minor
---

An agent file can carry its own hooks, for as long as one run of the agent lasts. Nothing is removed or renamed.

What you can now do:

- Put a `hooks` block, in either shape (ours or the common hook contract's), in an agent file's front matter (`~/.namzu/agents`, `.namzu/agents` or a plugin's agents). It is read by the reader the config files and skills use, so problems read the same. The hooks attach when a run of the agent starts, fire for that run's own tool calls and turns (not the delegating conversation's, a sibling's, or an agent it starts), and come off when it ends, however it ends. Two runs of one agent at once each have their own.
- Use `Stop` as "when this agent is about to finish": it fires where `SubagentStop` fires, with the agent's last message, once (the same command under both runs once), and can keep the agent working (`exit 2`, or a `block` decision with a reason).
- See them: `/hooks` lists the hooks a live run has attached, by agent name, and names agent files that carry hooks; `namzu doctor` (`runtime.hooks`), `namzu plugin validate` (`agent-hooks-problem`) and the terminal trust prompt name them. `disableHooks`, `NAMZU_DISABLE_HOOKS=1` and `hooksManagedOnly` stop them, and the agent then runs as if its file had no `hooks` key.

What to know: a guard that cannot be loaded is not an agent that runs unguarded. If an entry on an event that can refuse a call or a turn cannot be loaded (or the block is not YAML, has more than 32 entries, or has a `matcher` or `if` over 256 characters), the agent is not offered, and starting it is refused with a line that names the file and the entry. A project agent file that carries a guard is not offered while the folder is not trusted. A guard in one agent file does not follow the agent into the agents it starts. No command-line flag starts the main conversation as an agent definition, so nothing is attached for the main conversation.

What to do: an agent file of yours that already had a `hooks:` block written for another tool was ignored until now; it runs for each run of the agent, so read it first. The Desktop app's trust dialog does not list agent hooks yet.
