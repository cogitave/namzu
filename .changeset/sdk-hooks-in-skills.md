---
'@namzu/sdk': minor
---

A skill can carry hooks, and a host can take hooks off again. No exported name, key, field or default is removed or renamed. One behaviour changes for a skill that carries a `hooks:` block: a host that does not implement the new optional `SkillRegistryRef.prepareHooks` no longer applies that skill's `allowed-tools` pre-approval (it loads, with a line telling the model why); a skill without a `hooks:` block is read exactly as before.

What you can now do:

- Write a `hooks` key in a skill's `SKILL.md` front matter. The kernel keeps the block as text (`SkillMetadata.hooksSource`; `parseFrontmatter` takes a `raw` option and returns `rawBlocks`, and `SKILL_FRONTMATTER_RAW_KEYS` lists the keys read this way) because it is a list of mappings, which the front matter reader cannot hold, and no other key is read differently. `hooks` joins `SKILL_FRONTMATTER_KEYS`.
- Run a skill's hooks from your own host: the `skill` tool asks `SkillRegistryRef.prepareHooks` (new, optional) what to do about a skill that carries them. The answer says what to tell the model, whether the skill's `allowed-tools` pre-approval must be withheld (a guard that could not be loaded must not leave the skill running pre-approved), and `attach`, which the tool calls once the instructions are delivered, and for a `context: fork` skill around the delegated agent's run. A registry without `prepareHooks` loads a skill that carries hooks without its pre-approval and tells the model why.
- Attach hooks that can leave: `PluginLifecycleManager.attachHooks(pluginId, hooks)` returns a `HookAttachment` whose `remove` takes off exactly the hooks that call attached and `removeAt` one of them. Before, hooks left only by plugin id.
- Give every command of a `ShellHookOptions` adapter extra variables (`extraEnv`, which never replaces the kernel's own) and hear when a hook was selected to run (`onRun`).

What to do: if a skill of yours already has a `hooks:` block written for another tool, it was ignored until now. A host that runs skill hooks (the CLI does) will run it when the skill is used, so read it first. To keep the pre-approval on your own host, implement `prepareHooks` and return `withholdGrants: false`.

Also added: a hook event written at the top level of the front matter (`PreToolUse:` beside `name:`) is read as if it were under `hooks:` (`skillHooksSource`, `SKILL_FRONTMATTER_HOOK_EVENT_KEYS`; `SKILL_FRONTMATTER_RAW_KEYS` is unchanged); `SkillHooksOptions.prompt` carries a forked skill's delegated prompt so a host can bind the skill's hooks to the agent that received it; and the `skill` tool is an `executionBarrier`, so in one message the calls written before it finish first and the calls after it wait for it (their `pre_tool_use` hooks were still asked before the batch started, so a skill's `pre_tool_use` guard does not see a call written in the same message).
