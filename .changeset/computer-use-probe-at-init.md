---
"@namzu/computer-use": patch
---

`SubprocessComputerUseHost.initialize()` asks the desktop one cheap question (its geometry) after loading the adapter and refuses to become ready if it does not answer. Finding PowerShell on a WSL PATH is not the same as having an interactive Windows session to capture; the host used to report ready and let every screenshot fail the same way. The error names the adapter and what the desktop said, and a host that only ships the tool when `initialize()` succeeds now leaves it unmounted.
