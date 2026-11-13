---
'@namzu/sdk': minor
---

A skill can carry hooks, and a host can take hooks off again. Nothing is removed or renamed.

What you can now do:

- Write a `hooks` key in a skill's `SKILL.md` front matter. The kernel keeps the block as text (`SkillMetadata.hooksSource`; `parseFrontmatter` takes a `raw` option and returns `rawBlocks`, and `SKILL_FRONTMATTER_RAW_KEYS` lists the keys read this way) because it is a list of mappings, which the front matter reader cannot hold, and no other key is read differently. `hooks` joins `SKILL_FRONTMATTER_KEYS`.
- Run a skill's hooks from your own host: the `skill` tool asks `SkillRegistryRef.prepareHooks` (new, optional) what to do about a skill that carries them. The answer says what to tell the model, whether the skill's `allowed-tools` pre-approval must be withheld (a guard that could not be loaded must not leave the skill running pre-approved), and `attach`, which the tool calls once the instructions are delivered, and for a `context: fork` skill around the delegated agent's run. A registry without `prepareHooks` loads a skill that carries hooks without its pre-approval and tells the model why.
- Attach hooks that can leave: `PluginLifecycleManager.attachHooks(pluginId, hooks)` returns a `HookAttachment` whose `remove` takes off exactly the hooks that call attached and `removeAt` one of them. Before, hooks left only by plugin id.
- Give every command of a `ShellHookOptions` adapter extra variables (`extraEnv`, which never replaces the kernel's own) and hear when a hook was selected to run (`onRun`).

What to do: if a skill of yours already has a `hooks:` block written for another tool, it was ignored until now. A host that runs skill hooks (the CLI does) will run it when the skill is used, so read it first. A host that does not implement `prepareHooks` is not affected, except that such a skill's `allowed-tools` pre-approval is no longer applied.
