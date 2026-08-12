---
'@namzu/sdk': major
'@namzu/cli': major
---

A connected server no longer decides whether its own tool calls need approval

A server declared whether its own tools were read-only, and that declaration settled whether a call was approved without asking. The thing being gated supplied the input to the gate — on **three** independent paths: the kernel's `allow_read_only` rule, the CLI's prompt exemption, and the plan-mode pass in the executor.

The wire calls those fields *hints*. All three read them as facts.

**The asymmetry is the fix.** A self-declaration may raise the requirement and never lower it:

- `destructiveHint: true` from a server is still believed. A server volunteering that its tool is dangerous moves toward caution, and disbelieving it buys nothing.
- `readOnlyHint: true` no longer settles a call or skips a prompt on its own.

**Trust comes from the operator, per server.** A tool supplied by a connected server now carries `provenance: { server, readOnlyHintTrusted }`, and `isTrustedReadOnly` is the single predicate all three gates use. Never a global switch: one flag meaning "trust annotations" hands every connected server the same reach, which is the hole it would be closing.

`isReadOnly` still reports faithfully what the server said. Provenance and policy are different questions, and collapsing them would corrupt the outbound re-export and the destructive label a human is shown in order to fix a gate.

**What changes for you.** Calls to a connected server's read-only tools that were auto-approved now go to review or a prompt. Host-defined tools are unaffected and need no opt-in — they came from this process, with no untrusted party in the chain. To restore the old behaviour for a server you run yourself, mark that server's read-only hints trusted.

**More prompts is not automatically safer.** Measured work on approval UX finds miss rates rising with session length, so the per-server opt-in matters as much as the tightening does: an operator flooded with prompts approves by reflex, and that is the failure this change is trying to avoid, not cause.
