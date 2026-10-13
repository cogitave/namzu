---
"@namzu/cli": patch
---

On Windows, `namzu upgrade` now removes the `namzu.ps1` wrapper that npm writes
next to `namzu.cmd` after each update (only when it belongs to `@namzu/cli`).
PowerShell prefers that wrapper and the default execution policy refuses it, so
without this, typing `namzu` failed with "running scripts is disabled" after
every upgrade; now it runs `namzu.cmd`. Nothing changes on macOS or Linux. When
`namzu upgrade` cannot tell which installation it is running from, its message
now links the installation guide
(https://github.com/cogitave/namzu/blob/main/docs/cli/installation.md) instead
of a README section that no longer exists.
