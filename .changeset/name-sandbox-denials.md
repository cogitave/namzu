---
'@namzu/sdk': minor
---

A sandboxed command that fails with a read-only-filesystem error, or a permission error on a path outside the sandbox's allowed set, now carries a note that it looks like a sandbox denial (inferred from the error text), so the model asks to leave the sandbox instead of retrying. A launcher setup failure (`bwrap:`, `unshare:`, `sandbox-exec:` errors) is reported as a runner failure, not as the command failing. Additive: `SandboxExecResult` gains an optional `attribution` and `bash` results gain `data.sandboxAttribution`; nothing needs to change unless a custom sandbox backend wants to set `attribution` itself.
