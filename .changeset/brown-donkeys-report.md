---
'@namzu/cli': minor
---

A missing credential no longer strands you: enter one from inside namzu

Launching with a provider saved in `~/.namzu/preferences.json` and no credential
for it produced a screen you could do nothing on — a disabled composer, a hint
that read `Ctrl+C ×2 to exit`, and a message advising you to pick another
provider on the one screen that will not let you pick one.

That launch now lands in the **picker**, with the reason printed on the picker
itself, and you can:

- press `k` to enter a credential for the saved provider and carry straight on
  into a session, without leaving the program or setting an environment
  variable — including when other providers are detected, which previously hid
  the entry key entirely;
- or choose a different provider, or leave with `Esc` / `Ctrl+C`, both named on
  screen.

Entering a credential for the saved provider keeps the rest of your saved chain,
including a pinned model, rather than resetting you to the registry default.

**The entry screen now accepts a subscription token as well as an API key.** It
reads which kind you pasted, sends it on the wire accordingly, and says which it
took. A pasted subscription token has no refresh data with it, so it lapses
within hours and cannot be renewed — you are told that at the paste rather than
discovering it as an authentication failure mid-turn. A credential is still held
in memory for the session only and is never written to disk.

Two smaller corrections ride along: a base64 credential ending in `=` padding is
no longer rejected as a shell fragment, and a refusal that routes you to the
picker is now drawn *on* the picker (the transcript is not rendered during that
phase, so those explanations were previously invisible until after you had
already chosen).

Headless runs (`namzu -p`, `run-stream`, `drain`) are unchanged: a missing
credential still refuses, with the same exit code, and never silently moves your
run onto a different provider. The refusal's advice now names `--provider`,
which is the thing a scripted caller can actually do.
