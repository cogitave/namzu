---
'@namzu/sdk': minor
---

New `runConfig.sandbox.workspace`: `'ephemeral'` (default, unchanged behaviour) or `'working-directory'`. The second roots the sandbox at the run's own `workingDirectory`, so a sandboxed `bash` acts on the project the agent was asked about instead of on an empty temp directory.

That was the case the sandbox was wanted for and could not do. `SandboxCreateConfig.workingDirectory` existed and the local provider honoured it — and the kernel never set it, so anyone configuring a sandbox through `runConfig.sandbox` got a temp directory regardless of what the run was working on.

The default stays `'ephemeral'`. Changing it would be a major and would point every already-configured sandboxed run at real files.

`'working-directory'` on a run with no `workingDirectory` is **refused before the sandbox is created**, naming the config key. It does not fall back to ephemeral, and it does not reach for `process.cwd()`: that would confine whatever directory the host process happens to be in, which is not the tree you named, and telling a caller their files are protected by something not looking at them is worse than an error.
