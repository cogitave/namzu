---
'@namzu/sdk': patch
'@namzu/openai': patch
'@namzu/openrouter': patch
'@namzu/http': patch
---

A turn that asked for tools no longer ends because the provider said it
didn't.

The iteration loop ended the turn on `finishReason === 'stop'` **before**
looking at whether the model had asked for tools. Endpoints on the OpenAI
wire shape — gateways and local servers especially — routinely report `stop`
on the same response that carries a populated `tool_calls`, and three of
this repo's drivers passed that value straight through.

The damage was total and silent: every requested call skipped, an assistant
turn left carrying `tool_use` blocks nothing ever answered, and the run
settling as though it had finished the work it never started.

- **The runtime now treats tool calls as the fact and the finish reason as
  the summary.** When they disagree, the calls win. This is the load-bearing
  fix: it protects every driver, including ones this repo does not ship.
- **The three drivers that cast the reason raw now report it honestly** —
  a stream that produced a tool call reports `tool_calls`, whatever the
  endpoint called it. Defence in depth, and it makes the reported reason
  true for anyone else reading it.

The existing suite could not catch this: the scripted mock reports
`tool_calls` whenever it emits one, which is what an honest provider does
and therefore never the case that breaks.
