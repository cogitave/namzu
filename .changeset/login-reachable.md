---
'@namzu/cli': minor
---

Makes the subscription sign-in reachable from the screen that needs it, and
adds `namzu login` / `namzu logout`.

**The bug this fixes.** The sign-in shipped as `/login`. Slash commands are
typed into the composer, and the composer does not exist during the provider
picker — so the one operator who most needs to sign in, the one with no
credential at all whom namzu routes straight to the picker, was the one
operator who could not reach it. There was no other route: nothing else writes
the credential store. The screen listed the sources it scans, offered to take a
pasted key, and told them to set an environment variable and restart, while a
working sign-in sat behind a keystroke that did not exist.

- **`l` at the picker** starts the sign-in. namzu opens your browser and picks
  the result up when the page finishes.
- **`namzu login`** does the same from a bare shell, and also reads a pasted
  address from standard input — so a container or a remote machine with no
  browser can finish the sign-in. `--no-browser` skips the launcher,
  `--timeout <seconds>` bounds the wait. **`namzu logout`** removes the
  credential.
- **The picker's source list now names `~/.namzu/credentials.json`**, which it
  scanned and did not mention.

There is deliberately no `namzu login --code <value>`: the PKCE verifier lives
in the process that started the sign-in, so a second invocation could not
finish the first one's attempt. A flag that looks like it should work and
cannot is worse than its absence, so the paste is read by the waiting process
instead.

Two message defects found by running it rather than reading it: a bare Enter at
the prompt spent the whole attempt on an empty paste, and a failed sign-in in a
terminal told you to "run /login" — a slash command, in a shell.
