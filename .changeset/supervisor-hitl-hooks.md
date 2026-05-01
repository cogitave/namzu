---
'@namzu/sdk': minor
---

`SupervisorAgentConfig` accepts `resumeHandler` and `verificationGate`.

The supervisor's existing tool-review pipeline (drainQuery's
`runToolReview` phase) was reachable only by callers that constructed
`drainQuery` arguments by hand — `SupervisorAgent.run` ignored them
entirely and always fell back to `autoApproveHandler`. Hosts that
wanted "Ask before acting" semantics had no way to plug in.

`SupervisorAgent.run` now forwards both fields verbatim to
`drainQuery` when the caller supplies them. Behaviour is unchanged
for callers that omit them — the SDK still defaults to auto-approve.

Migration:

```ts
new SupervisorAgent({...}).run(input, {
  ...config,
  // surface tool_review_requested events to the user; resolve when
  // they approve / modify / reject.
  resumeHandler: async ({ runId, toolCalls, ... }) => {
    return await waitForUserDecision(runId, toolCalls)
  },
  // optionally pre-classify tools so trivial reads bypass review.
  verificationGate: { enabled: true, rules: [...] },
})
```
