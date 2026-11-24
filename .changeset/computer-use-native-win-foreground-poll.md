---
"@namzu/computer-use": patch
---

With the opt-in native Windows helper (`NAMZU_WIN_HELPER`), a window that came to the front but for which the system sent no foreground event was missing from the monitor. The monitor now also reads the window in front when it is polled and records the change. Nothing needs doing on upgrade.
