---
'@namzu/cli': major
---

Two defaults changed: the mode that skips every question is no longer offered from a menu, and the computer tools are off until you turn them on.

Bypass permissions mode is now hidden from Desktop's permission chip and from any ACP client until you opt in with the new `permissions.allowBypassMode: true` in your own config file (or the managed file; a project file's value is ignored and said so). Before, it was offered by default. A prompt that asks for bypass over ACP without the opt-in is refused, and Shift+Tab in the terminal app stops on it once the opt-in is set. Flags you type (`--yolo`, `--dangerously-skip-permissions`, `--permission-mode bypass`) and `permissions.defaultMode: bypass` in your own file still start a bypass session, `permissions.disableBypassMode: true` in any file still shuts it for good and wins over the opt-in, and the root guard is unchanged. To keep the old behaviour of Desktop offering Full access, set `permissions.allowBypassMode: true`. Settings gains *Allow bypass permissions mode*, which asks first.

`computer_use` is now offered only when `computerUse.enabled: true` is set in your own config file or the managed file (it was always offered in the terminal app and in Desktop conversations that use this computer). A project file cannot turn it on. To keep the old behaviour set `computerUse.enabled: true`. The new `computerUse.deniedApps` is a list of apps the computer tools never act in, added up across files, and is checked inside the tool before any call reaches the screen. Settings gains *Enable computer use* and *Denied apps*. Namzu never hides other apps, so no setting to unhide them exists.
