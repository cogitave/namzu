---
'@namzu/cli': minor
---

Sign in with a subscription instead of pasting an API key.

`/login` runs an authorization-code sign-in with PKCE and stores the result in
`~/.namzu/credentials.json`, on every platform. namzu refreshes it as it
expires and finds it again on the next launch; `/logout` removes it. If you
already use an environment variable or a typed key, nothing changes — this adds
a door, it does not move one.

**On a machine with no browser** the sign-in still works. namzu prints the
address; open it wherever you have a browser and hand the result back with
`/login <address-or-code>`. namzu tells you at the time whether the automatic
hand-back is available on your machine, rather than leaving you waiting for one
that is not.

**The credential file is private, and namzu proves it rather than assuming it.**
It is written owner-only and the protection is then read back — the mode on
Linux and macOS, the access-control list on Windows, where a POSIX mode proves
nothing. If that check cannot be made the file is deleted and the sign-in fails
with a reason.

**Whose OAuth client namzu presents is recorded in the source, next to the
value** (`packages/cli/src/integrations/providers/identity.ts`). It is not
namzu's own: the authorization server accepts no other client for plan-backed
inference and the vendor operates no open registration, so the choice was
between using it and not offering the capability. You sign in on the vendor's
page against your own account; nothing is proxied through a namzu service.

Nothing is added to a package's runtime dependencies, and no existing export
changes shape. Two additions a consumer of `@namzu/cli`'s types may notice:
`DetectionSource` gains a `'stored'` member, so an exhaustive `switch` over it
needs an arm; and a discovered provider's `oauth` metadata gains an optional
`origin`, which defaults to the previous behaviour when omitted.
