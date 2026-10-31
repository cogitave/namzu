---
'@namzu/cli': patch
---

The conversation screen is now mounted on a pass-through pair of terminal streams, the groundwork for zooming out to a spaces screen and back without leaving the session. Nothing changes for a person using it: output to the terminal is byte-identical, startup is unchanged, and the zoom code is only loaded on first use, behind the temporary `NAMZU_ZOOM_DEBUG=1` environment variable (ctrl+] toggles). It is off on Windows and when the terminal is not interactive.
