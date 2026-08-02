---
'@namzu/sdk': minor
---

A long-running tool can report progress.

Tools get a deadline of up to two minutes by default, and before this they
were silent for all of it: a host could show that a build, a test run or a
long fetch had started, and then nothing at all until it finished or timed
out.

- `ToolContext.report(message, fraction?)` — fire-and-forget, returns void,
  never throws back into the tool, so it can be called without wrapping.
- `tool_progress` run event (wire: `tool.progress`), carrying the tool name
  and `toolUseId` so a host rendering a concurrent batch knows whose
  progress it is. A `fraction` outside [0,1] is clamped rather than passed
  on.
- Ephemeral, like `text_delta` — excluded from `transcript.jsonl`, so a
  tool reporting every file it compiles cannot bloat the durable record.

The model never sees these. Progress answers "is it still working?", which
is a question only a human asks, and putting it in the conversation would
spend tokens telling the model something it cannot act on.
