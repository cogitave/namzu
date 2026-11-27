---
'@namzu/computer-use': minor
---

The native Windows helper can now tell which control a person used, without any input hook: new `watch.start`, `watch.poll` and `watch.stop` ops (and a `watch` entry in `hello`'s `caps`) report invokes, focus and selection changes, menus and windows opening and closing, the text of ordinary edit fields and the program in front, from read-only UI Automation subscriptions. No key, typed character, mouse button or pointer position is ever reported; a password field says `secure: true` and its text is never read. Nothing changes for existing callers: a helper without the `watch` cap is refused by the new `NativeWatch` client, and every existing op behaves as before.
