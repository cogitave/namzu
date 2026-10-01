# Live agent messaging foundation

## Evidence

Actual interactive runs of the installed original CLI used Sonnet 5.5. Two
independent processes discovered each other by name and exchanged HELLO/ACK
through local Unix sockets. The incoming peer message was attributed separately
from operator input. See `artifacts/claude-native-observations.json`; busy peer
delivery and different permission modes were not established by that experiment.

Source snapshots inspected without running their setup scripts:

| Source | Revision | Useful contract |
| --- | --- | --- |
| Codex | `60947e234156ac12bdb7fba2477d3965f166bd34` | Mailbox message, task that wakes an idle agent, and interrupt are separate operations. Delivery phases distinguish current-turn input from next-turn mail. V2 is disabled in the installed CLI, so this is source evidence. |
| Pydantic AI | `1748def380cbcf1dc02974a3922cfda63c177563` | Pending messages drain before model requests and again at graph completion; ASAP and when-idle are distinct. |
| Hermes | `12e4d3e2dd5281adf289f70e5d6c7f33427d6982` | Acceptance closes together with the final drain; accepted but undelivered steering is reported explicitly. |

## Existing Namzu foundation

Parent-child messages already use the task gateway and manager inbound callback,
which the query loop drains at provider-valid boundaries. Enter steers an active
turn; Tab queues an operator follow-up. Neither needs A2A. Two defects in the
description: the public manager comment incorrectly says the loop never reads
the queue, and the child activity rail calls an accepted message delivered.

The SDK already exports the experimental local peer registry, endpoint, client
and provenance envelope. Its CLI lifecycle and inbox policy were never wired.
Implement that host layer instead of adding another transport or daemon.

## Selected implementation

- A live TUI instance has its own peer identity, distinct from its current
  durable conversation, child task, Pal identity and execution environment.
- Reuse SDK local sockets / Windows pipes. Only verified live TUI peers in the
  same canonical project and permission mode may enqueue messages automatically.
  Different modes are refused explicitly; no implicit approval or permissions
  transfer. Directory visibility alone grants no tool approval.
- `list_sessions` exposes public discovery fields, never endpoint tokens.
  `send_session_message` addresses a live instance by exact id, short ref or
  unambiguous title. Existing parent-child `send_message` retains its contract.
- `/peers` reports peers and queue state; `/peers on|off` controls participation;
  `/peers send <target> <text>` sends from the operator's terminal.
- Bounded, process-local mail wakes an idle ready TUI; during work it drains at
  the existing inbound boundary, without cancelling tools or in-flight model
  requests. Source is `runtime-context/peer-message`, never operator input.
- Bind accepted mail to the current conversation generation. A conversation
  switch cannot reroute it to a new conversation. Off, stopped/failed queue,
  prompts and model replacement do not silently start extra work.
- A response says queued/refused/unreachable, never understood or completed.
  IDs suppress duplicate acceptance in a bounded live-instance window. No
  automatic retry after an uncertain connection outcome.
- Graceful close reports remaining mail locally. Crashes can lose process-local
  mail; durable cross-machine tasks and exactly-once effects are outside this
  transport. Do not describe it as durable orchestration.

Pal grouping and lead roles can use this messaging foundation later. A2A remains
the external interoperability boundary; it is not the internal mailbox protocol.

## Verification required before closing this work

Real socket tests: discovery, verified attribution, duplicate IDs, capacity,
wrong modes/projects, switch/close fencing, idle versus busy boundaries. Existing
operator-steering and child-task tests must remain green. Two independent Namzu
TUI processes must exchange real protocol messages through a scripted provider;
retain actual request histories and rendered screen evidence, explicitly marked
as a transport fixture rather than live-provider capability evidence.
