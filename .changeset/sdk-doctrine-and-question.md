---
"@namzu/sdk": minor
---

The coding-agent doctrine, and a question that needs no gateway.

- **`CODING_AGENT_WORKING_DOCTRINE`, `CODING_AGENT_DELEGATION_DOCTRINE`, `PLAN_MODE_DOCTRINE`, `codingAgentDoctrineContribution(options?)`** — the rules that say HOW an agent built on this kernel works: act or ask, deliver the whole scope, report faithfully, prefer the bounded tools over their shell equivalents, what is off-limits in git without a person saying so. The working text names only builtin tools and suits every agent; the delegation text names `task_create` and `Agent` and suits the parent only, and `codingAgentDoctrineContribution({ delegation: false })` leaves it out for a sub-agent. The contribution is `static` and renders after `systemPrompt`, so a host keeps its own identity block in front of it.
- **`buildAskUserQuestionTool({ resumeHandler, runId?, questionParks?, pendingAnswers? })`** — `ask_user_question` on its own. It was reachable only through `buildCoordinatorTools`, which demands a gateway and a roster the question never uses and a run id at build time; the standalone builder takes the park handler and reads the run id from the calling `ToolContext` unless one is pinned. `buildCoordinatorTools` registers the same tool through it.

Nothing existing changed.
