---
'@namzu/sdk': minor
'@namzu/computer-use': minor
'@namzu/cli': minor
---

Windows computer use can capture pixels for one named window with `screenshot {window_id}` and keep background clicks and drags, text and keys bound to that window. Window `type_text` and `key` can explicitly request `delivery_mode: 'foreground'` for browser text or modifier shortcuts that cannot run in the background; this may briefly bring the verified window forward. The pinned driver sets `windowScroll: false` and refuses scoped pixel scrolling because its wheel input cannot prove which window receives it; a host that supports safe window scrolling can offer it. Capture identity and window geometry are checked before input; moved windows, old captures and restarted driver sessions require a new window screenshot. Hosts can offer window capture without display capture, in which case `window_id` is required and plain display screenshots remain unavailable. A failed window capture never broadens to a display capture. When both browser and computer-use tools are ready, the CLI routes a named existing browser window to computer use, leaving browser tools for the separate Namzu-managed profile.
