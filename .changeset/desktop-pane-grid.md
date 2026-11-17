---
'@namzu/desktop': patch
---

The panel beside a conversation is now a grid of panes: Terminal, Changes, Browser and Files, plus the session panel. Each button in the top bar opens its pane and closes it again; panes stack in at most two columns, the conversation keeps at least 360 px and is no longer covered by a pane in a window of ordinary width, and the layout is remembered for each conversation group. The Outputs and Activity tabs are gone: a page a turn writes opens in Browser and other files in Files, whose tree marks new and modified files. Terminal opens on Ctrl+' (Cmd on a Mac), Browser on Ctrl+Shift+B and Files on Ctrl+Shift+F; Ctrl+B still folds the sidebar. The sidebar no longer folds when a pane opens.
