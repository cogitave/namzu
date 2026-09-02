---
title: The agent-client protocol bridge — what a peer may call, and what it must declare
description: How an editor or orchestrator drives a namzu agent over stdio, why a session is refused for a client that cannot ask a human, how tool calls are rendered by the tool rather than the bridge, and why the method table is two hand-written sets compared in both directions.
type: Guide
status: stable
resource: packages/sdk/src/bridge/acp/server.ts
tags: [sdk, bridge, protocol, stdio, permissions]
generated: { by: human:bahadirarda, at: 2026-08-21T00:00:00Z }
---

# The agent-client protocol bridge

An editor extension or a CI orchestrator could do two things with namzu:
shell out to the CLI and scrape stdout, or embed `@namzu/sdk` in its own
process. `ACPServer` is the third — a wire surface a peer written in any
language can drive, over the `ServerStdioTransport` this package already
had.

`namzu acp` runs it against this process's stdio.

## The command ships with the bridge, and that is the point

`MCPServer` is a complete protocol server, exported from this SDK, that
nothing in the tree has ever constructed. A wire surface with no driver
reads as a supported feature and is not one — nobody finds out it does not
work, because nobody runs it.

So `packages/cli/src/commands/acp.ts` landed in the same change, and the
test that holds it spawns the real binary and completes a handshake over a
real pipe. Deleting the registration in `cli.ts` fails five tests.

## What a client must declare

```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": { "capabilities": ["permission", "fs"] } }
```

`permission` is **required**. A `session/new` from a client that did not
declare it is refused, naming the capability.

That refusal is the design rather than a limitation. A session that cannot
ask a human anything and runs every tool regardless is not a degraded
version of asking — it is the opposite of it, arrived at by omission. A
client that cannot show a prompt should not get a session that silently
approves everything on its behalf.

`fs` is **optional**, and it changes what the agent reads. See below.

## Methods

| Client calls | |
|---|---|
| `initialize` | Version, agent info, the command surface, required and optional capabilities. |
| `session/new` | Create a session. Refused without `permission`. |
| `session/load` | Resume one, answered with the **same** id. |
| `session/prompt` | Run a turn, streaming updates, answered with a stop reason. |
| `session/cancel` | Abort the running turn. |

| Agent calls | |
|---|---|
| `session/update` | Notification: a message chunk, a thought, a tool call, a turn boundary. |
| `session/request_permission` | Request: may this tool batch run? |
| `fs/read_text_file`, `fs/write_text_file` | Request: the editor's buffer, when `fs` was declared. |

**The method set cannot drift from the pinned version.** `ACP_METHODS` and
the server's handler map are authored independently, and a test compares the
two sets in both directions: a handler nobody advertises fails, and an
advertised method with no handler fails. Deriving one from the other would
have made that test a tautology.

An unknown method answers `-32601` **and the connection stays open** — a
client probing for a feature must not lose its session because this agent
does not have it yet. A malformed frame is survived for the same reason.

## Session identity is connection-owned

One connection may carry several sessions, but one session id names exactly
one record for the lifetime of that connection. Creation and loading share a
single reserved/open namespace. A load reserves its caller-supplied id before
waiting on the store; generated ids skip both open and still-loading records.
Loading an open id, loading the same absent id twice, or returning a colliding
host-generated id is refused rather than replacing the record already running
under that name.

Each record owns its absolute working directory, cancellation controller,
permission latch and conversation history. Relative working directories are
refused. Different sessions can run prompts concurrently; a second prompt for
the **same** session is refused until the first settles. The check happens
before a fresh cancellation controller is installed, so `session/cancel`
cannot be redirected away from the turn it was meant to stop.

After a prompt settles, an `AcpAgentGateway` may return `history` beside its
stop reason. The server copies that replacement into only the owning session,
and passes it to the next prompt. A gateway that does not own durable history
may omit it. This is the bridge between a wire session and the runtime's exact
provider-replay conversation; it is not reconstructed from rendered updates.

## stdout belongs to the protocol

One stray `console.log` anywhere in the process corrupts the message stream,
and the symptom at the far end is "malformed JSON" with nothing naming the
culprit. This repository's logger writes to stderr, and a subprocess test
asserts zero non-JSON bytes on the child's stdout with info-level logging
on.

## Tool calls are rendered by the tool

A `session/update` of kind `tool_call` carries a `ToolCallView` from
`createToolPresenter` — the presenter asks the **tool** how it wants to be
shown. No module in the bridge compares a tool name, and a test asserts it:
a front end that switched on `'edit'` could never give a diff to a tool it
had not heard of, which is every MCP server's and every plugin's.

The closed view kinds remain `generic`, `diff`, and `terminal`. A generic view
may additionally carry `presentation: 'activity'`, meaning its label is a
complete activity rather than an argument summary, or `visibility: 'hidden'`
on a redundant successful result. Older clients ignore those additive fields
and still render the label; clients that honor hidden visibility must never
hide a failed status.

The client-visible command list is `HostCommandRegistry.describe()`
verbatim, asserted by registering a command the bridge has never heard of
and expecting it to appear.

## Permission, and the two ways it goes silently wrong

The agent sends `session/request_permission`; the client answers
`approve`, `approve_all`, or `reject` with optional feedback.

- **A denial reaches the model.** It maps to the kernel's `reject_tools`
  with the client's feedback, so the next turn takes a different path. A
  bare denial gets a default sentence, because an empty feedback reads to a
  model as a tool that failed for no reason and it retries.
- **`approve_all` carries the grant keys.** `approve_tools` with nothing
  remembered is indistinguishable from a plain approve, which is how an
  "approve all" that never takes gets shipped. A plain approve remembers
  nothing: consent is not transferable.
- **The latch is per SESSION.** A second session from the same process asks
  again. One person's "stop asking me" must not cover the next session this
  process serves, which may be a different repository, editor window, or
  human.
- **Cancellation revokes the outstanding question.** The request is removed
  under the prompt's abort signal. A permission dialog the client answers late
  no longer owns authority, so even a late `approve_all` cannot latch consent
  onto the next turn. The cancelled prompt reports `cancelled`, not a generic
  run error. The CLI applies the same lifetime while a lazy runtime session is
  still being constructed: the wire prompt settles immediately, while the
  reserved construction remains observed and any late candidate is closed.
- **The server stamps the owning session id.** A gateway supplies the tool
  batch, but cannot relabel a question from session A as session B. The id shown
  to the human and the permission latch receiving the answer therefore name the
  same server-owned record.

An answer the agent cannot parse is treated as a refusal, never as consent.

## The editor's buffers as the filesystem

A user with unsaved changes had the agent read disk, see a version nobody is
looking at, and patch *that* — so the model's diff is computed against text
the user already replaced.

A client declaring `fs` answers reads and writes instead.
`clientBackedSandbox` decorates the existing `Sandbox` rather than
implementing one: a client-backed object with only the file methods would
take `bash` away from a session that had it. A failed client read **rejects**
rather than falling back to disk, because stale text is exactly what the
capability exists to stop.

## Resumption

`session/load` asks the gateway's own session store and answers with the
same id — a client that asked to resume `ses_x` and got `ses_y` back has to
rewrite everything keyed by the old one. A gateway with no store **refuses**
rather than returning an empty history, which a client cannot tell apart
from a session that really had no turns.

Resuming carries the same `permission` requirement as creating. A refusal on
`session/new` that `session/load` walks around is not a refusal.

## The session is built lazily

`initialize` and `session/new` are how a client discovers what this agent is
and what it requires, and neither needs a model. Building the session up
front made a namzu with no configured credential answer a connection attempt
by exiting — an editor saw a pipe close, with the reason on a stderr nobody
was reading. The refusal now names the missing credential at the first
prompt, where it matters.

The CLI preserves that laziness without collapsing the sessions together. At
the first prompt for a wire session it checks stored folder trust, pins the
admitted canonical directory, activates that project's permission, tool-server
and sandbox configuration, and builds one runtime session for that wire id.
Another wire id gets another runtime session and event route. Permission
questions carry the real id, and connection teardown closes every constructed
session; a construction that resolves after teardown is closed instead of
being published.
