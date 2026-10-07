# Conversation header proof

Screenshots of the Desktop design preview (sample data) after the review fixes.

| File | Shows |
| --- | --- |
| artifacts/01-menu-dark-wide.png | The "..." actions menu, dark theme, 1440 px. Archive is neutral like the other rows. |
| artifacts/02-fork-submenu.png | Fork submenu (flipped left at the window edge). |
| artifacts/03-copy-submenu.png | Copy submenu. |
| artifacts/04-rename-dialog.png | Rename dialog, prefilled and selected. |
| artifacts/05-details-popover.png | Conversation details popover after a rename (sidebar and tab show the new title). |
| artifacts/06-pinned-sidebar-dark-wide.png | Pinned conversation: pin after the title in sidebar and Recents, pin in the tab. |
| artifacts/07-side-chat.png | New side chat: the source stays in the left pane, the fork opens on the right. |
| artifacts/08-menu-light-narrow.png | Actions menu, light theme, 640 px. |
| artifacts/09-details-light-narrow.png | Details popover, light theme, 640 px. |

Measured checks (all pass, printed by the script):

- Every menu row, Archive included, has the same computed text colour.
- A pinned sidebar row's label starts at the same x (88 px) as its unpinned siblings.
- The pinned conversation's tab carries a pin icon.
- After a side chat each pane has an active tab and the left one is the source conversation.
- The details popover opens 50, 150 and 300 ms after the actions menu closes (the reported flake did not reproduce).
- At 640 px the details popover lies fully inside the viewport (x 300, width 320).

Rerun: start the Desktop dev server (`pnpm --filter @namzu/desktop dev`), then
`node research/conversation-header-20261007/capture.mjs`. Set `PREVIEW_URL` if it is not on port 5173.
