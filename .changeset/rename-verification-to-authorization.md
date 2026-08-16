---
'@namzu/sdk': minor
'@namzu/cli': patch
---

The verification gate is an authorization gate, and is named one. Old names
still work and are marked `@deprecated`; they go in the next major.

| Old | New |
| --- | --- |
| `VerificationGate` | `AuthorizationGate` |
| `VerificationRule` | `AuthorizationRule` |
| `VerificationGateConfig` | `AuthorizationGateConfig` |
| `verificationGate` (config field) | `authorizationGate` |

A reader who saw `VerificationGate` expected something that verifies a claim
— checks a signature, confirms an output matches a schema. It is a rule
engine that decides, before a tool runs, whether the call is permitted:
allow, deny or review, by name, category, tier, or a pattern over the
arguments. Every rule variant already said so. The misreading was not
academic: the module sat beside real guardrail and HITL neighbours, where
"verification" suggests exactly the post-hoc double-check the guardrails do.

The config field is on `ReactiveAgentConfig`, `SupervisorAgentConfig`,
`runAgent`'s options and `QueryParams`. Both spellings are accepted for the
window and resolved at one site; setting both to different configs throws
and names both fields. One resolve rather than four matters more here than
for an ordinary rename — a gate present on one path and absent on another
means a tool call permitted where it should have been refused.

Also renamed, and reachable only in type position: `VerificationRuleSchema`
and `VerificationGateConfigSchema`. They are not exported as values, but
`import type` and `typeof` both worked, so they carry aliases rather than
disappearing.

Deliberately unchanged, because each is already correct about what it is:
`GateDecision`, `GateEvaluationResult`, `ToolCallContext`, `describeRule`,
`evaluateRule`, `defaultSandboxedGateConfig`,
`defaultSandboxedShellGateConfig`.

The module-invariant registry — `createInvariantRegistry`, `invariants`,
`InvariantRegistry` and friends — moved to its own directory rather than
into `authorization/`. It is the one thing in the old `verification/` that
genuinely verifies a claim: what a module says about its own live state. No
import path changes for consumers; it is exported from the same barrel.
