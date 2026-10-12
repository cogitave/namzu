---
"@namzu/cli": patch
---

On Windows, reading a Pal computer's status no longer starts the Linux machine Pal computers run on. Namzu Desktop reads that status every few seconds while a Pal's panel is open, so the machine used to start again right after it was stopped for being idle. Status now reads what setup recorded; starting the computer still starts the machine. Nothing changes for Docker or Podman.
