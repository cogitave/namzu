# Side panel tabs, 2026-10-07

Changes and Activity are now ordinary tabs in the same list as open files, drawn by one component.
Compare with the owner's references `6.png` (files only) and `12.png` (a single Changes tab).

Dark is 1440x900, light is 900x720, both from the live preview (`/preview`, sample data).

| File | Shows |
|---|---|
| `{dark,light}-01-changes-active.png`, `-01-strip.png` | Changes active (bordered raised tab), Activity beside it, "+" and the Expand / Hide buttons |
| `*-02-file-active.png`, `-02-strip.png` | A file active; Changes and Activity are plain muted tabs |
| `*-03-many-tabs.png`, `-03-strip.png` | Several files open; file tabs truncate (min 112px, inactive names use the full width, the x lies over the right end on hover, edges fade), fixed tabs keep their names, the strip scrolls |
| `*-04-plus-menu.png` | "+" with Changes and Activity open: only "Open file…" |
| `*-05-plus-menu-closed-fixed.png` | After closing both: Changes, Activity, separator, "Open file…" |
| `*-06-activity-active.png` | Activity re-added from the menu and shown |
| `*-07-expanded.png` | Expanded: the panel fills the pane, the conversation is hidden, button reads "Restore panel" |
| `*-08-empty.png` | Every tab closed: empty body with Changes, Activity, Open a file |
| `*-09-activity-badge.png`, `-09-strip-badge.png` | Activity count badge while two background processes run |
| `*-09-activity-badge-attention.png`, `-09-strip-badge-attention.png` | The same badge in the warning colour (`/preview?attention`) |
| `*-03b-overflow.png`, `-03b-overflow-strip.png` | Eleven tabs: every file tab is 112px, names stay readable, the strip scrolls with faded edges |

Checked by script on both sizes: the tab list after each step, the menu entries, Escape leaving an expanded
panel expanded, expanded state surviving a reload, and closing every tab with Delete and Ctrl+W.
