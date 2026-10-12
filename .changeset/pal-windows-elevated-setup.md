---
"@namzu/sandbox": minor
---

`@namzu/sandbox/local-virtual-computer/setup` gains the pieces that need Windows' permission: `runElevatedWslcSteps` turns on Virtual Machine Platform (and, on Windows 10, the WSL optional component) and installs the pinned WSL package in one elevated Windows PowerShell process, so a plan shows Windows' permission prompt at most once; `PINNED_WSL_PACKAGE` names Microsoft's WSL 3.0.1.0 x64 package with its size and SHA-256; `downloadWslPackage` fetches it with resume, retry and a digest check; `registerResumeAtSignIn` and `clearResumeAtSignIn` ask Windows to continue setup once at the next sign-in. Nothing existing changes. These functions did not work before this release (they threw "not implemented yet"), so no caller relies on an earlier behaviour.
