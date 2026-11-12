---
'@namzu/sdk': minor
---

The rules the plugin loader applies to a manifest, a skill and an agent file can now be called on text, so a host can check a plugin without loading it. New exports: `parsePluginManifestText` (the parse and schema steps of `loadPluginManifest`), `assertEnableable` (the enablement check it then makes), `parseSkillMarkdown` (what `loadSkill` applies to a `SKILL.md`) and `AGENT_FILE_KEYS` (the frontmatter keys an agent file reads). `loadPluginManifest` and `loadSkill` now call them and behave as before; nothing is renamed or removed.
