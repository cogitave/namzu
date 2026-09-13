---
"@namzu/sdk": minor
---

Supply configured advisors with the successfully dispatched SDK request,
including request-only step context, followed by records appended from its
response onward. The public `AdvisoryCallContext.turn` and exported
`AdvisoryTurnContext` describe this optional trajectory. Records distinguish
request inputs from later tools and messages within one shared context window.

Snapshots are scoped to one iteration, omitted from checkpoints, and rebuilt
after resume. If the current response anchor is unavailable, the advisor sees
explicitly labelled canonical history instead. Same-batch results that have not
yet reached history are not synthesized. No additional model call is enabled.
