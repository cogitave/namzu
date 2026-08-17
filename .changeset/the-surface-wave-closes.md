---
'@namzu/sdk': major
---

The NZ-SURF-05..08 deprecation wave closes. 28.0.0 carried every name below;
this release removes them.

| Removed | Use |
| --- | --- |
| `collect` | `collectChatCompletion` |
| `Registry` | `BaseRegistry` |
| `ContextCache`, `ContextCacheConfig` | `PromptCache`, `PromptCacheConfig` |
| `RunClaim`, `ClaimFence`, `ClaimSummary` | `RunLease`, `FencingToken`, `LeaseSummary` |
| `TaskGateway`, `LocalTaskGateway` | `TaskScheduler`, `LocalTaskScheduler` |
| `VerificationGate`, `VerificationRule` | `AuthorizationGate`, `AuthorizationRule` |
| `VerificationGateConfig`, `VerificationGateConfigSchema`, `VerificationRuleSchema` | the `Authorization*` spellings |

Four configuration fields go with them, each an old spelling of a field that
still exists:

| Removed field | On | Use |
| --- | --- | --- |
| `contextCache` | `QueryParams` | `promptCache` |
| `taskGateway` | `QueryParams` | `taskScheduler` |
| `verificationGate` | `QueryParams`, `ReactiveAgentConfig`, `SupervisorAgentConfig` | `authorizationGate` |
| `gateway` | `SupervisorAgentConfig` | `scheduler` |

Every removal is a rename. The values, the shapes and the behaviour are
unchanged — `Registry` and `BaseRegistry` were the same class object, and
`instanceof` held across both spellings while the aliases existed.

Setting both spellings of one field used to be refused at the top of the run
with a message naming both. That check goes with the old names, and so does
`pickRenamed`'s last caller; the helper stays for the next wave.

If you are still on an old spelling, the compiler will name every site. There
is no runtime failure mode here — a removed type is a build error, and a
removed config field is silently ignored by `exactOptionalPropertyTypes` only
if your own type declares it, which is why these are listed field by field
above.
