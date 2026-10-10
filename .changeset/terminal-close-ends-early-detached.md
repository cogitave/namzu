---
"@namzu/cli": patch
---

Closing a terminal on Linux now also ends a program that left the terminal's process tree straight away. `setsid` started from an interactive shell forks and exits at once, so the program was reparented before the host could find it and kept running after the terminal closed. Every program started in a terminal now inherits `NAMZU_TERMINAL_ID`, set to the terminal's id, and the host ends this user's processes that still carry it once the terminal has ended. This includes a background service first started from that terminal, such as a `tmux` server or `ssh-agent`, even if another terminal uses it by then. Nothing to change on upgrade; start a program that must outlive its terminal outside it. Windows is unchanged and adds no variable.
