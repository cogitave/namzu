---
'@namzu/computer-use': minor
---

`NativeWatch` is now exported, with `NativeWatchOptions`, `NativeWatchStart`, `NativeWatching`, `NativeWatchEvent`, `NativeWatchKind`, `NativeWatchPollReply` and `NATIVE_WATCH_KINDS`. It watches which controls a person invokes, focuses or selects, and which windows and menus open, through read-only UI Automation subscriptions in the native Windows helper. It reads no key and no mouse button; a password field reports `secure` and never its text. Nothing existing changes: a program that does not import it is unaffected.
