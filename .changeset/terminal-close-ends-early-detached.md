---
"@namzu/cli": patch
---

Closing a terminal on Linux now also ends a program that left the terminal's process tree straight away. `setsid` started from an interactive shell forks and exits at once, so the program was reparented before the host could find it and kept running after the terminal closed. Every program started in a terminal now inherits `NAMZU_TERMINAL_ID`, set to the terminal's id, and the host ends this user's processes that still carry it once the terminal has ended. Nothing to change on upgrade; a program that must outlive its terminal should be started outside it.
