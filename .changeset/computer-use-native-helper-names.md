---
'@namzu/computer-use': minor
---

The native Windows helper is renamed from `namzu-win` to `namzu-native`: the program is `namzu-native.exe`, the protocol is `namzu-native/1`, and the variable that names it is `NAMZU_NATIVE_HELPER`. Nothing breaks in this release. `NAMZU_WIN_HELPER` is still read when `NAMZU_NATIVE_HELPER` is absent or blank, a helper built before the rename is still greeted (the client says `namzu-native/1`, and once `namzu-win/1` if the helper refuses it), and a helper path is run whatever its file name. `WIN_HELPER_ENV` keeps its value, `NAMZU_WIN_HELPER`, and is deprecated; it is no longer the name the package prefers, so code that reads the variable itself should check `NAMZU_NATIVE_HELPER` first and fall back to `NAMZU_WIN_HELPER`. If you set `NAMZU_WIN_HELPER`, you need do nothing now; switch to `NAMZU_NATIVE_HELPER` before the next major release, which stops reading the old variable and the old protocol name.
