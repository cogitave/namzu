---
'@namzu/cli': minor
---

A hooks block moved from another tool runs as written when its commands start with that tool's project-folder variable: `"$SOMETOOL_PROJECT_DIR/.hooks/check.sh"` now finds the folder, because any unset variable ending in `_PROJECT_DIR` that a hook command refers to is set to the project folder.

For a script that reads such a variable inside its own file, a hook entry takes `env`, a map of names to text (`"env": { "SOMETOOL_PROJECT_DIR": "${NAMZU_PROJECT_DIR}" }`), in both the flat shape and the common shape. `/hooks` and the folder trust prompt list the names it sets (never the values), and it is part of what makes two entries the same. A bad name or a value that is not text is refused in the flat shape and left off with a note in the common shape. When a hook cannot find its program and its command refers to a variable that is set nowhere, the failure line names the variable and the `env` key, and the `runtime.hooks` row of `namzu doctor` warns about such a command before it fails. Nothing existing changes; the doctor row can now show a warning for a hook that refers to an unset variable.
