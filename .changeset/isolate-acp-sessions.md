---
'@namzu/sdk': major
'@namzu/cli': patch
---

Isolate every live agent-client protocol session by identity, working
directory, cancellation and exact provider history.

**What breaks in the SDK:** one ACP session now permits only one unsettled
prompt, and session working directories must be absolute. Hosts that submitted
overlapping prompts under one id must wait, cancel, or use distinct sessions;
hosts that passed a relative `cwd` must resolve it first. Session creation and
loading also share one collision-refusing namespace, so loading or generating
an already open id no longer replaces its live record.

Gateways may return the settled conversation beside the stop reason so the next
prompt receives exact replay state. The CLI drives that seam with one runtime
session per wire id, activates trusted target config only at the first prompt,
routes events and permissions to the owning id, and closes late or connection-
owned sessions on teardown. Cancelling during lazy runtime construction now
settles the wire prompt immediately while retaining ownership of, and later
closing, any session candidate that arrives after cancellation.
