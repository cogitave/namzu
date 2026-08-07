---
'@namzu/cli': minor
---

You can type a credential into a running namzu instead of restarting.

With no key discovered, the picker used to list three sources and say "then
restart namzu" — accurate, and a cliff: the product told you to leave it in
order to use it. It now also offers `k`, which takes a key and starts the
session with it.

**Held in memory for that session only, and written nowhere.** The screen says
so before you type and again afterwards, and names the environment variable that
makes it durable.

That is a decision, not an omission. The obvious durable home is the OS
keychain; namzu's keychain support is macOS-only and reads a *different*
product's credential store, so a key written there would be filed under someone
else's name — and on Windows there is no keychain path at all. The remaining
option was a plaintext file. A secret at rest should be something you chose, not
something that arrived because you typed into a text field.

- **Masked while typing** — never the key, and never its length either, since
  length distinguishes vendors and tiers.
- **Checked at the moment you type it**, by listing models, which costs nothing.
  A rejected key leaves you on the screen with what you typed intact.
- **Never claims a check it did not do.** A provider with no cheap way to
  validate a key is reported as exactly that, with the first message named as
  the real test.
- **Never reaches a transcript or an error.** Errors carry the provider's
  reason, truncated, and the function that writes the message is not given the
  key.

A typed credential shows as `typed · this session only` wherever providers are
listed.
