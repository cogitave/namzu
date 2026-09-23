---
'@namzu/cli': patch
---

The permission screen shows a shell command as it would be typed. It used to escape the command the way JSON does, so `printf '%s\n' "$out"` read as `printf '%s\\n' \"$out\"`. A multi-line command now shows one row per line, later lines indented under the first; a carriage return and other invisible characters are spelled out as `\u{....}`, and `d` still shows the exact input. Nothing to change on your side.
