---
'@namzu/sdk': minor
---

A plugin's declared skills actually load and reach the model.

The manifest schema validated `skills` with a per-plugin cap and the runtime then refused the whole plugin for declaring any — so a plugin shipping four tools and one skill validated clean, installed clean, and contributed nothing. The refusal was correct while there was no path into `SkillRegistry`; this is the path.

Pass `skillRegistry` to `PluginLifecycleManager` and a plugin's skills load from the directories its manifest names. Without one, a manifest declaring skills is still **refused** — accepting it and dropping the skills would produce a plugin reporting `enabled` that contributes nothing its author declared, which is the same lie the wholesale refusal was written to prevent.

Skills are namespaced like tools (`plugin__skill`), because two plugins shipping `reconcile` would otherwise overwrite each other in a Map keyed by the frontmatter name, and the loser would vanish with nothing reporting it. The namespaced name is written into the skill's own `metadata.name` too, so the registry key and what a rendered prompt shows agree.

What a plugin brought, it takes away: skills are unregistered on rollback and on disable. A disabled plugin whose skills stayed registered keeps offering the model instructions from something the runtime switched off — worse than a stale tool, because a tool call would at least fail and a skill is followed silently.

`SkillRegistry` gains `add(name, skill)` and `unregister(name)`. `connectors` and `personas` remain refused; a skill registry does not buy them a manifest path.
