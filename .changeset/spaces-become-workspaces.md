---
"@namzu/cli": minor
---

`namzu spaces` is now `namzu workspaces`, and a "space" is called a workspace throughout the screen (sidebar, prompts, keybinds overlay, help, the `←` hint). Nothing you have set up stops working in this release:

- `namzu spaces` still starts the same screen, as a deprecated alias of `namzu workspaces`.
- `tui.spacesPrefix` is still read when `tui.workspacesPrefix` is not set; if both are set the new one wins. A value that is not a usable key is refused under the key it was written in. Move the value to `tui.workspacesPrefix`.
- The remembered layout moves from `spaces.json` to `workspaces.json` in your Namzu home. The first time `namzu workspaces` runs and `workspaces.json` does not exist, `spaces.json` is read and written out as the new file. `spaces.json` is never changed or deleted, so an older Namzu keeps working against it; after that only `workspaces.json` is read.
- The private environment variables and terminal message between the host and its sessions were renamed (`NAMZU_WORKSPACE_SLOT`, `NAMZU_WORKSPACE_HOST_PID`, `namzu-workspaces`). A session and a host from different builds still find each other: the old names are read and the old message is still recognised and stripped.

The alias, `tui.spacesPrefix`, the `spaces.json` fallback and the old variable and message names are removed in the next major release. If a script reads the terminal's wording, `/status` now labels the sandbox file mode "Files" instead of "Workspace", so it no longer shares a word with the workspaces screen.
