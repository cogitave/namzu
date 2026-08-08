---
'@namzu/cli': patch
---

**Credential discovery now states what it asks, and still lists only what it can
use.**

The `discoverProviders` header said it asks "three questions in order" and then
listed two. The omitted one was the Keychain read — the question that takes a
secret off the machine, so the one a reader most needs to see. It now lists
three, in execution order (environment variable, Keychain, local probe), and
states plainly that **the Keychain path is macOS-only**: on Windows and Linux
there are exactly two doors, and a credential kept only in the OS credential
store is not found. That is a gap rather than a nuance, and it is now written
where someone reading the file will meet it.

**A local provider whose server is not running is still not listed**, and the
dead branch that proposed listing it is removed. Membership in the discovery
list means "usable right now", and that is a contract two readers depend on: the
`providers.chain` doctor check reads presence itself as the verdict for a
provider that needs no key, and the session's chain builder applies no
credential test to a local one. An entry for a down server would report it
`reachable` and build it into the chain, failing on the day it was supposed to
rescue a run. The operator-facing intent behind that branch already exists in
the picker's empty state, which names both local servers and their ports and
says to start one.

No behaviour changes: the removed branch had an empty body, guarded by a
condition (`!opts.skipProbes === false`) that did not mean what the comment
above it said. Closes #258.
