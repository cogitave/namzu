---
'@namzu/cli': major
---

`namzu mcp serve` runs Namzu's built-in tools (`read`, `write`, `edit`, `glob`, `grep`, `bash`) as a tool server on stdin and stdout, so another program can use them. Your permission rules apply to every call and a `deny` always wins; a call that would need your approval is refused with a message naming the rule to add, unless the launch flags allow it (`--permission-mode`, `--allowed-tools`, `--disallowed-tools`, `--add-dir`, `--trust`).

`namzu mcp add json <name> '<json>'` adds a server from one JSON object with the shape of a config entry. `json` is the JSON form only when exactly two arguments follow it and the second is a JSON object; `namzu mcp add json node server.js` still adds a server named `json`.

`namzu mcp add` and `namzu mcp remove` take `-s, --scope user|project` (project writes `.mcp.json` and the server waits for `namzu mcp approve`). `add` takes `-t, --transport stdio|http`, `-e, --env NAME=value` and `-H, --header 'NAME: value'`.

Two spellings are retired and now print the new form and exit 64 without saving anything:

- `--env NAME` is now `--env NAME=${NAME}` (it saved the variable name to pass through; the new form saves a reference to it).
- `--header NAME=VALUE` is now `--header 'NAME: VALUE'` (the value must still be `${ENV_VAR}` or `Bearer ${ENV_VAR}`).

Scripts that call `namzu mcp add` with the old spellings must change to the new ones. Nothing shipped in this repository (Desktop, the installer, workflows) used them.
