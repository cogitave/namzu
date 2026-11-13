---
'@namzu/cli': patch
---

A very long reply in the fullscreen view (`tui.fullscreen`) takes far less memory and processor time while it streams, and nothing changes on the screen. Every row is still there to scroll back to, search and select, and a copy still holds the whole text. The view now lays out only what a new piece brought instead of the whole reply again, and keeps one copy of each row. There is nothing to switch on or off. In a real terminal a 1 MB reply of code took 19 s of processor time and 0.8 GB at its peak instead of 45 s and 2.6 GB; smaller replies gain less, and a key typed meanwhile still shows within about 70 ms. The default screen is untouched.
