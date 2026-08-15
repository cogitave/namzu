---
'@namzu/sdk': patch
---

Skill and plugin discovery loggers respond to configureLogger again

`skills/loader.ts`, `skills/registry.ts` and `plugin/loader.ts` each built their logger once, at module-eval time, via a top-level `const logger = getRootLogger().child({...})`. `child()` bakes the root logger's level into the closure it returns, and the module graph loads before any host's `configureLogger()` call has run — so whatever level was live at that moment was permanent. No later `configureLogger()` call, from a host application or from the CLI's own silencing, could ever reach these six log lines.

Each of the six call sites (`loadSkill`, `discoverSkills`, `SkillRegistry.registerAll`, `resolveSkillChain`, `discoverPlugins`, `discoverAllPluginDirs`) now resolves its own `getRootLogger().child(...)` at the top of the function body, at call time — matching the idiom already used elsewhere in the kernel (`runtime/query/context.ts`, `run/reporter.ts`, `agents/RouterAgent.ts`).

No exported signature changed. A host that never calls `configureLogger()` sees identical output; a host that does now gets what it asked for.
