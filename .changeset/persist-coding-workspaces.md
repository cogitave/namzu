---
'@namzu/cli': major
'@namzu/sdk': major
'@namzu/sandbox': minor
---

The coding CLI now runs sandbox-aware tools against the canonical project directory by default, and project changes survive individual turn and child-run teardown. Set `sandbox.workspace` to `ephemeral` to retain the previous disposable per-run workspace behavior.

The SDK now honours `SandboxCreateConfig.workingDirectory` in `LocalSandboxProvider`, carries run-level sandbox workspace policy through `runAgent`, reactive, supervisor, and delegated-agent entry points, and requires providers to advertise `working-directory` support before receiving a host project path. Custom providers used with `sandbox.workspace: 'working-directory'` must add that mode to `workspaceModes`; omit the workspace mode to retain ephemeral behavior. `PipelineAgent` refuses this setting because arbitrary developer callbacks cannot be confined by the tool sandbox.

The optional sandbox package now advertises its construction-time container and guest layouts as ephemeral-only instead of accepting a per-run host directory it cannot mount.
