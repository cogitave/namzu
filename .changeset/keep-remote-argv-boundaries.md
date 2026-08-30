---
'@namzu/sdk': minor
---

Add an argv-preserving remote command seam. Configure `RemoteExecutionContext` with `commandExecutor` (or call `setCommandExecutor`) and use `executeCommand(command, args, options)` so Namzu forwards argument boundaries without joining them into one string. `RemoteCommandHandler`, `commandHandler`, `setCommandHandler`, and `executeRemote(line, options)` are now deprecated; they remain compatible for this release and keep their existing joined-string behavior when no structured executor is configured.
