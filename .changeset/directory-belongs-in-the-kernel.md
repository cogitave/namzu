---
'@namzu/sdk': minor
---

the agent-directory loader is part of the SDK

It shipped briefly as a separate package. The name was the tell: nothing fit.
`project` collided with `ProjectId`, the tenancy bucket every run already
carries, and it described a scope that no longer existed once `channels/` and
`schedules/` were cut. `agent-dir` was a hyphenated abbreviation, out of family
with `skills`, `plugin`, `registry`, `sandbox`.

A directory reader that needs the kernel to be useful is a function of the
kernel, not a product beside it. So it is one now:

```ts
import { loadDirectory, deriveRunOptions, runAgent } from '@namzu/sdk'

const { manifest, ok, diagnostics } = await loadDirectory('./agent')
if (!ok) console.error(diagnostics)

const { output } = await runAgent(
  deriveRunOptions(manifest, { provider, prompt: 'What is the weather?' }),
)
```

Nothing about the convention changed — the same `agent.ts`, `instructions.md`,
`tools/`, `skills/`, `agents/` layout, the same `modules: 'skip'` mode, the same
diagnostics, the same `deriveSupervisorOptions` for a directory that declares
delegates. Only the import path and the names.

**Nobody has to migrate.** The package was never published — a `@namzu/project`
install has always 404'd — so there is no consumer to move and no deprecation
window owed. The rename that would have cost a major after publishing cost
nothing before it.

Renames, if you were following the source: `loadProject` → `loadDirectory`,
`ProjectManifest` → `DirectoryManifest`, `ProjectConfig` → `DirectoryConfig`,
`ProjectSlot` → `DirectorySlot`, `ProjectLoadResult` → `DirectoryLoadResult`,
`ProjectDiagnostic` → `DirectoryDiagnostic`, `LoadProjectOptions` →
`LoadDirectoryOptions`. `DiagnosticCode` and `DiagnosticSeverity` gained a
`Directory` prefix as well — bare, in a shared namespace, they read as the
SDK's own diagnostic vocabulary rather than one loader's.

A side effect worth naming: `@namzu/project` was the one package the release
pipeline could not publish, so every release since `#102` ended red on its
`E404`. That failure goes with it.
