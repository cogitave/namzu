---
"@namzu/sdk": minor
---

The `skill` tool can tell the model which directory a skill's files are in (#536).

New `createSkillTool({ resolveModelDirectory })`, with the types `SkillToolOptions`, `SkillDirectoryResolver`, `SkillDirectoryRequest` and `SkillDirectoryContext`. `resolveModelDirectory(skill, { sandbox })` receives the registered name and the directory the host reads the skill from, and returns the directory the model's tools can open, or `undefined` when they cannot reach one. With it:

- a load opens with `[Skill directory: <dir>. …]` on its first page and reports `data.directory`; when the resolver answers `undefined` it says instead that the skill's directory is not reachable in this session and not to search the filesystem for it;
- the listing (`skill` without a name) gives each skill's `directory` and no longer the registry's `location`, which is the host's path;
- `${CLAUDE_SKILL_DIR}` in `allowed-tools` expands to the resolver's directory, and an entry using it is ignored when there is none.

The skill is still loaded from the registry's own path. `SkillTool` is `createSkillTool()` and behaves exactly as before, so nothing changes unless you pass the option. `SkillRegistryRef.catalog()` entries may now carry an optional `directory`, and `SkillRegistry.catalog()` sets it to the skill's directory; a registry that omits it still satisfies the interface.
