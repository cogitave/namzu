---
'@namzu/cli': patch
---

On Windows, the PowerShell installer now invokes npm and Namzu through their `.cmd` shims, so a Restricted execution policy does not block their `.ps1` wrappers. A successful npm install that writes a warning to stderr no longer aborts the installer. It requires the CLI's actual minimum, Node 22.13. Provider diagnostics now name the Claude Code credential files checked when no Claude session is available, and `/setup` explains that Desktop sign-in does not guarantee a reusable Code CLI session. Command Prompt installation instructions use `npm.cmd`.
