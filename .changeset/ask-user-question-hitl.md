---
'@namzu/sdk': minor
---

Add a model-authored `ask_user_question` HITL surface to the coordinator
toolset. `HITLDecisionRequest` gains a `user_question` variant carrying
`UserQuestionData` (questionId = the asking `tool_use_id`, question text,
optional header, 2-4 model-authored options, multiSelect, allowFreeText),
and `HITLResumeDecision` gains `answer_question` (selectedOptionIds,
optional freeText, optional questionId echo as a misdirection guard).
The tool registers only when `buildCoordinatorTools` receives BOTH a
`resumeHandler` and a `runId` (SupervisorAgent threads its configured
`resumeHandler` through automatically), parks the run through the same
ResumeHandler channel as plan approvals, and returns the user's answer
verbatim as the tool result — selections quote question and labels,
free text is rendered "in their own words", and an empty/misdirected/
mismatched answer yields an explicit "the user did not answer" sentinel
instead of fabricated consent. The tool is deliberately NOT
concurrency-safe so multiple questions in one assistant turn park
strictly one at a time against host run-keyed park registries.
Headless callers degrade safely: `autoApproveHandler` answers
`user_question` with the no-selection sentinel ("No user is available
to answer. Proceed using your best judgment."), so runs without an
interactive ResumeHandler never deadlock and never invent a choice.
Existing ResumeHandler implementations compile unchanged (additive
union widening); bare plan-approval and tool-review flows are
byte-identical.
