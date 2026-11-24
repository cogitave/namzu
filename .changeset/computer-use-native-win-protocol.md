---
"@namzu/computer-use": minor
---

Adds the TypeScript side of `namzu-win/1`, the line protocol of the native Windows helper that is replacing the PowerShell scripts behind Windows computer use: the codec, `NativeWinProcess` (starts the compiled helper directly, no shell and no PowerShell) and `NativeA11yBackend`, in `src/native/` (not exported from the package yet). On Windows, or under WSL, setting `NAMZU_WIN_HELPER` to the path of `namzu-win.exe` makes `createWindowsA11yHost` return the native backend instead of the PowerShell host. Nothing sets the variable and nothing delivers the helper yet, so no existing behaviour changes and nothing needs doing on upgrade; the new backend is opt-in until delivery lands.
