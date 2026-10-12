---
'@namzu/sandbox': minor
---

Add the Windows Pal computer setup core under `@namzu/sandbox/local-virtual-computer/setup`: `inspectWslcReadiness` (reads policy, Virtual Machine Platform, WSL and wslc versions and the loaded image without starting a virtual machine unless `probeSession` is set), `planWslcSetup`, `runWslcSetup` (refuses a consent whose plan no longer matches the PC), `loadWslcImage` (checks the bundled archive's size and SHA-256 and the loaded image's id and protocol before recording it), `stopIdleWslcSession` and the restart record. Nothing existing changes; the download of the WSL package, the elevated process and the sign-in resume entry arrive separately.
