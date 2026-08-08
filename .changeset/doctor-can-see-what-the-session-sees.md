---
'@namzu/cli': minor
---

**`namzu doctor` now reports provider-chain capability disagreements.** It
listed which members had credentials and could not say whether the chain it was
describing could run at all — so a chain with every key in place reported
`pass`, and the operator found out it was unusable by trying to start a session.

Reading what a provider declares requires that provider's package to be
registered, and the only registration path was module-private inside the
interactive session. A diagnostic that cannot see what the thing it diagnoses
sees is checking the wrong thing. `ensureRegistered` and
`resolveChainCapabilities` now live beside the registry, in
`integrations/providers/register.ts`, and the session and the doctor reach them
without either importing the other.

`providers.chain` gains three outcomes:

- **fail** — the members disagree and the mismatch has not been accepted, so a
  session will be refused. Reported ahead of the credential result, because it
  stops every run.
- **warn** — the mismatch has been accepted. Still named: the session prints it
  on every launch, and a diagnostic that went quiet would disagree with the
  thing it describes.
- **warn / fail** — a member whose declaration could not be read, listed
  separately from the disagreements because an unanswered question is not a
  conflict. `fail` when it is the primary, which cannot start a session either.

The cost is named rather than hidden: this check now dynamically imports the
driver package of every member in the chain. That is the price of reading a
declaration, on a command whose whole job is to look.

No behaviour changes inside a session — the registration state is one set in one
module, as it was, because two copies would double-register and throw.

Closes #262.
