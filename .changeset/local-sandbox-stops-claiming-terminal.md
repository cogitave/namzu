---
'@namzu/sdk': major
---

Stop exposing an unconfined host pseudo-terminal as a local sandbox capability.

`LocalSandboxProvider` previously implemented `Sandbox.openTerminal` by starting a host PTY in `rootDir`. That changed only the working directory: it bypassed the provider's selected isolation tier, accepted host process configuration, and was not owned or awaited by `Sandbox.destroy()`.

Local sandboxes no longer expose `openTerminal`. Supplying the legacy `LocalSandboxProviderOptions.ptyLoader` injection now fails with the boundary reason instead of accepting configuration the provider cannot honour. The option and the optional `Sandbox.openTerminal` member remain deprecated for a release window; the contract now requires an implementing backend to confine the complete terminal process tree and to kill and await it during `destroy()`.

**What breaks:** code that opened a terminal from `LocalSandboxProvider` must stop doing so. Use `loadPty` and `openTerminalWith` directly only when intentional host execution and externally owned teardown are correct, or provide a terminal backend that owns both confinement and the complete session lifetime. The generic helpers no longer claim to create a sandbox.
