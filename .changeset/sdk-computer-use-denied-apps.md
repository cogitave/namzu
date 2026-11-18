---
'@namzu/sdk': minor
---

`createComputerUseTool` takes `deniedApps`, a list of application names the tool never acts in. A call whose window (a window id it names, a window screenshot's window, or the window under a click or in front for a key) is a listed application is refused before the host is touched, with a message that says nothing was done; a look at the whole display and `list_windows` are not refused. When the host cannot list windows, an acting call is refused while the list is not empty. Absent or empty, behaviour is unchanged.

A `ui_snapshot` or `wait_for` that names no window is checked against the window in front, and a window id the fresh window list cannot place (or a list that could not be read, for a call that names a window) is refused while the list is not empty.
