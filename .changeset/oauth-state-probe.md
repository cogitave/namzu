---
'@namzu/evals': minor
---

Adds a `security/` suite category, and its first probe: **does `state` derive
from the PKCE verifier?**

`npx namzu eval` over this package now runs one more suite. Nothing existing
changes — the `kernel/` suites, their ids and their scores are untouched — so
the upgrade is additive unless you gate on the total suite count.

**Why the probe exists.** In authorization code + PKCE only the challenge, the
hash of the verifier, may travel in the authorization URL. `state` travels
there too, so a flow that sets `state = verifier` writes the verifier into the
address bar, the browser history and any referrer, and the protection is gone
while every part of the ceremony is still present. It is a defect
implementations ship.

**Why it is not caught by the obvious test.** `state !== challenge` holds for
the broken flow — necessarily, since the challenge is the SHA-256 of the
verifier — so the assertion a careful person writes passes while the property
is broken. Even `state !== verifier` catches only literal reuse.

The probe is importable at `@namzu/evals/security/oauth-state.js` and answers
with the *name* of the relation it found, so you can point it at your own flow:

```js
import { auditAuthorizationRequest } from '@namzu/evals/security/oauth-state.js'
const { sound, findings } = auditAuthorizationRequest({ url, state, verifier })
```

It reads one captured attempt against a fixed list of derivations. A finding is
proof of coupling; no finding is not proof of independence, and the list is
written out in the source so the bound is visible.
