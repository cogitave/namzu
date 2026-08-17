---
'@namzu/cli': minor
---

Add `/mcp`, which shows which tool servers connected, what each exposes, and which failed.

The facts were reported once, at connect time, as transcript rows that scroll away. Ten minutes into a session there was no way to ask again — and a server that failed to start is, from the operator's seat, indistinguishable from one nobody configured. That is exactly the state they are in when a tool they expected is simply not there.

Failures are listed as prominently as successes and never omitted, because a page that showed only what worked would look correct and complete on a machine where nothing did. "No session yet" and "no servers configured" are reported as the different facts they are.

Tools are **named**, not counted. A count answers "did it connect"; the operator's actual question is whether the tool they wanted is among them. The names are carried from the listing at connect time rather than recovered afterwards by splitting the `mcp_<server>_` prefix apart — that prefix is an encoding `integrations/mcp/servers.ts` owns, and recovering it elsewhere would make it a format two places have to agree about.
