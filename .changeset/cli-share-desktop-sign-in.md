---
"@namzu/cli": minor
---

In WSL, the terminal now uses a Claude or Codex sign-in made in Namzu Desktop on Windows when the terminal has none of its own for that provider, so you no longer have to sign in again on the terminal. It reads Desktop's sign-in file in place and writes refreshes back to that same file under the same lock, so there is one sign-in, not two copies that invalidate each other. A sign-in made on the terminal always wins and is kept separate, and `namzu logout` in the terminal never signs Desktop out. To keep the terminal to its own sign-ins, set `shareDesktopSignIn: false` in your config file or `NAMZU_SHARE_DESKTOP_SIGNIN=0`. Nothing changes outside WSL, with `NAMZU_HOME` set, or for a terminal that already has its own sign-in.
