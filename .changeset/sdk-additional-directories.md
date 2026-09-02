---
"@namzu/sdk": minor
---

A run can reach directories besides its working directory. `query({ additionalDirectories })` — absolute paths — is threaded to every file tool as `ToolContext.additionalDirectories`: relative paths still resolve against the working directory, an absolute path inside any added directory is accepted, and anything else outside is refused as before (`resolveWithinAny` / `resolveWithinAnyReal` / `toolRoots` in `tools/paths`). A sandboxed run binds each added directory read-write at its own path (`SandboxCreateConfig.additionalDirectories`: bwrap `--bind`, seatbelt `subpath` rules), and the local sandbox's own file API is contained to the same set.
