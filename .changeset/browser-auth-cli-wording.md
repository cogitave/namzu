---
'@namzu/cli': patch
---

When a browser returns an HTTP authentication challenge, the terminal handoff and `namzu browser login` output ask the operator to check access without claiming that a sign-in or password screen appeared. `browser login` does not update the profile's "last sign-in" time from that challenge alone. Other browser handoff messages keep their existing wording.
