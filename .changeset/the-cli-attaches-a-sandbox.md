---
'@namzu/cli': major
---

The CLI runs commands in a sandbox, and you can configure it

`sandboxProvider` appeared **zero times** in this package. `query()` attaches a sandbox only when one is supplied, so `context.sandbox` was always undefined and `BashTool` took its fallback branch — `execAsync` in the host process, with `{ ...process.env }`. Every credential your shell holds went to every command the model chose to run, on every path, interactive included. The isolation the documentation described held nowhere.

**A sandbox is now attached by default.** Nothing to configure to get it.

**And it is yours to control**, under a new `sandbox` block:

```yaml
sandbox:
  enabled: true                            # default; false runs on the host
  requireIsolation: [filesystem, network]  # refuse to start unless enforced
```

`requireIsolation` is empty by default, and that default is honest rather than safe: available isolation differs per platform, so requiring anything by default would refuse to run on machines where the CLI works today. Name a control and you get a refusal at startup instead of a surprise at runtime.

**Every session reports what it got**, including when the answer is "nothing". A sandbox that confines nothing is not the same as no sandbox and is not protection, so the notice says which controls are enforced and which are not, and says outright when commands are unconfined.

**Why `major`.** Commands now run inside a sandbox, so anything reaching a path outside the workspace, or the network where the platform confines it, behaves differently. Set `sandbox.enabled: false` to keep the old behaviour — a real choice with a real reason, announced on startup rather than assumed.
