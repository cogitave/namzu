---
"@namzu/sdk": patch
---

**Security.** Closes two authorization bypasses in the tool-review path.

A gate rule that explicitly denies a tool call could be overridden by a human. When a batch mixed a denied call with a reviewable one, the whole batch went to the reviewer, and approving it executed every call — including the denied one. Denied calls are now removed from the batch before the reviewer ever sees them, receive their denial result immediately, and cannot be restored by any decision. Deny rules also take global precedence in `VerificationGate`: rule order now decides allow-versus-review and nothing else, so an earlier allow rule can no longer mask a later deny.

A `modify_tools` decision rewrote a call's arguments and executed them without re-evaluating the gate, so a benign call could be modified into an operation the rules deny. Every modified call is now re-evaluated against the deny plane before execution, and an exception raised while evaluating one is a denial, not an approval.
