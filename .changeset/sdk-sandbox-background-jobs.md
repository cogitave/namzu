---
"@namzu/sdk": minor
---

Background jobs inside the sandbox. `Sandbox.spawnDetached(command, args, { cwd, env })` — optional on the interface, implemented by the local provider for bwrap, seatbelt, namespace and basic tiers — starts a process under the same confinement as `exec` and hands it back running, with a `kill` that reaches bwrap's inner reaper. The background job registry accepts a `spawn` in `StartJobParams` (and `bindOwner` a `spawn` default) so the sandbox starts the job and the registry keeps it; the executor now binds jobs to a sandboxed run when its sandbox can spawn detached, and withholds them otherwise. `run_in_background` under a sandbox that cannot says so (`SANDBOX_CANNOT_DETACH`) instead of blaming the host.
