---
"@namzu/sdk": minor
---

The ACP bridge's `approve_all` latch no longer answers a permission request that holds a call marked to always ask a person. `AcpPermissionRequest` calls take an optional `alwaysAsk`; a request with a marked call is sent to the client even when the latch is set, and an `approve_all` answer to it approves that request once and leaves the latch as it was. A call without the field is an ordinary call, so a host that sends none behaves as before. To get the new floor, set the mark from `mustAskPerson(call)`, now exported with the `MustAskCall` type. A host that relied on the latch silencing every ask, including a sandbox escape, a protected path or a rule's ask it forwarded, now sees those asks again once it sets the mark; one that does not set it keeps the old latch.
