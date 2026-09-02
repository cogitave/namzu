---
"@namzu/cli": patch
---

File-defined agents and the read-only `explore` delegate now run on the kernel's loader, filters and prompt. `.namzu/agents/<name>.md` keeps its shape and behaviour; the CLI only decides the two directories and their order (user, then project shadowing it) and hands the rest to `@namzu/sdk`. One tightening rides along: a connected server's tool that merely claims to be read-only no longer reaches an `explore` or `readOnly: true` roster unless the server's read-only hints are trusted — the same rule the authorization gate already applied.
