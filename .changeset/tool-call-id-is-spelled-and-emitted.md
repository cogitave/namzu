---
'@namzu/sdk': major
---

The tool-call id attribute is spelled the way the convention spells it, and something now sets it

`GENAI.TOOL_CALL_ID` was `'gen_ai.tool.call_id'` — one underscore where the
GenAI attribute registry has a dot, and where the two constants beside it in the
same object (`gen_ai.tool.name`, `gen_ai.tool.type`) already had one. Its value
is now `'gen_ai.tool.call.id'`.

**What breaks.** The exported constant is `as const`, so both its value and its
literal type change. If you import it and stamp it on your own spans, those
spans start carrying a different key, and a saved query, dashboard panel or
alert that groups by `gen_ai.tool.call_id` will match nothing after the upgrade
— it will read as "no tool calls", not as an error. Anything that pinned the
old literal as a type (`typeof GENAI.TOOL_CALL_ID`, or a union built from it)
fails to compile.

**What to do.** Repoint anything keyed on `gen_ai.tool.call_id` at
`gen_ai.tool.call.id`. If you referenced the constant rather than the string,
there is nothing to change beyond taking the upgrade. Traces already in your
backend keep the old key; a query that has to span the upgrade needs both for
as long as the old retention window lasts.

There is no deprecation window, and the reason is that no working code needs
one: nothing in this SDK ever emitted the attribute, under either spelling. The
constant was exported with no writer at all — `registry/tool/execute.ts` stamped
the tool name and the tool type onto the span and stopped — so no namzu-produced
trace has ever carried the old key, and there is nothing to migrate off it.

**What is added.** The tool span now stamps the id of the call it is about,
taken from `ToolContext.toolUseId`, which the run loop already sets per call.
Before this, a trace showing four tool spans with the same name in one turn
could not say which span answered which `tool_use` block. The attribute is
omitted rather than set to `undefined` when there is no call to correlate to —
a host invoking a tool directly, outside a run.

Tool **arguments** and **results** are deliberately still not recorded. They are
the thing an incident review wants first and they are also where a secret
travels, so they want a redaction design and a test for it rather than a ride
along with a spelling fix.
