# Messaging verification and reproduction

Follow-up: [live child workflow and direct operator messages](CLAUDE-CHILD-WORKFLOW.md)
records a real synchronous 120-second child tool, a correction queued before
that tool completes, direct child-composer input during a second blocking tool,
and same-child idle follow-up. It also identifies the missing direct child UI
and completed-child follow-up operations in Namzu. The earlier experiments below
retain their original evidence limits.

Baseline: `308522a5fde0508428257c0a30d4a023d4ac5a62`. All changes in the owned
`feat/runtime-desktop-foundation` worktree. Main and the operator's saved
conversations and scheduled jobs were not changed by these experiments.

## Evidence boundaries

| Experiment | Actual components | Established | Limit |
| --- | --- | --- | --- |
| Original parent/child | Installed interactive CLI, Sonnet 5.5, real background Bash and SendMessage | A correction changed the same child's final marker | The child model call had stopped while Bash ran; not proof of interrupting an executing tool |
| Original independent peers | Two interactive processes, discovery and local sockets, Sonnet 5.5 | HELLO/ACK by session name, attributed peer input, idle wake | Busy peer delivery and mode mismatch were not tested in this original CLI |
| Namzu busy/idle peers | Two shipped TUI processes, real local sockets, scripted provider | Busy receiver shows pending mail; apparent final is followed by peer input and another request; idle sender wakes for ACK | No live-provider capability claim; Linux only |
| Namzu provider failure | Two shipped TUI processes, real local sockets, scripted non-retryable error | First peer turn fails; second mail stays pending with one receiver request; operator continuation delivers it; three receiver requests in total | This is controlled failure injection, not a live provider outage |
| Automated tests | Real sockets/filesystem plus real-screen App fixture and existing SDK/CLI tests | Capacity, identity, authority, modes, generations, deduplication, close, admission and failure hold | Process-local acceptance is not durable or exactly-once execution |

See `artifacts/*observations.json` for selected actual request history and
`artifacts/*.txt` for VT-emulated screens. Raw original-provider captures are
kept in the owned scratch directory, not committed with account traffic.

## Defects reproduced during implementation

1. Conversation materialization changed readiness through a ref without another
   render. Discovery retained `acceptsMessages: false` while the TUI was busy.
   Publish again at actual turn admission, after installing its inbound inbox.
2. A failure with an empty operator queue left no pause gate. Later peer mail
   could restart work automatically. Every failed/stopped non-goal turn now
   holds automatic work until explicit operator continuation.
3. Idle peer mail can already have a queued wake when operator admission wins.
   The active turn drained that mail but a failed turn left its old queue row
   visible. Drain now removes corresponding queued wakes immediately.
   `namzu-peer-failure-before-queue-fix.txt` is the reproduced defect;
   `namzu-peer-failure-resumed.txt` is the corrected native process observation.
4. Concurrent shutdown callers now await the same close promise; messaging
   becomes disabled before endpoint cleanup. The real socket test also checks
   this repeated-close contract.
5. Updating an optional peer record must not crash the main turn. A real registry
   move test checks messaging switches off, reports why and refuses sends.

The App regression drives an actual renderer and queue, with provider settlement
controlled by a promise. The socket tests await their operations. No test uses
elapsed wall time as its success criterion.

## Repeat the native Namzu transport experiment

Use a built worktree and two terminals with the **same** scratch root/project.
This is a scripted-provider transport fixture; do not use it for account traffic.

```sh
export NAMZU_PEER_FIXTURE_REPO="$(pwd)"
export NAMZU_PEER_FIXTURE_ROOT="$(mktemp -d /var/tmp/namzu-peer-XXXXXX)"
export NAMZU_HOME="$NAMZU_PEER_FIXTURE_ROOT/home"
export XDG_RUNTIME_DIR="$NAMZU_PEER_FIXTURE_ROOT"
export OPENAI_API_KEY=fixture
python3 - <<'PYSETUP'
import json, os
from pathlib import Path
root=Path(os.environ['NAMZU_PEER_FIXTURE_ROOT'])
(root/'home').mkdir(); (root/'project').mkdir()
(root/'home'/'preferences.json').write_text(json.dumps({'version':3,'providers':[{'id':'openai','model':'gpt-5.6-luna'}],'subagents':{'active':[]}}))
(root/'home'/'trust.json').write_text(json.dumps({'version':1,'trusted':[str(root/'project')]}))
(root/'project'/'namzu.config.json').write_text(json.dumps({'sandbox':{'enabled':False},'web':{'search':'off'},'memory':{'recall':False}}))
PYSETUP
cd "$NAMZU_PEER_FIXTURE_ROOT/project"
unset CI
# Choose receiver in terminal A, sender in terminal B. Copy the root/home env
# values to B; do not create a second scratch root.
export NAMZU_PEER_FIXTURE_ROLE=receiver
node --import "$NAMZU_PEER_FIXTURE_REPO/research/agent-messaging-20261001/namzu-tui-preload.mjs" "$NAMZU_PEER_FIXTURE_REPO/packages/cli/dist/bin.js" --dangerously-skip-permissions
```

Receiver: submit `RECEIVER_BUSY`. After the `busy-request-held` event is written,
sender: submit `SEND_PEER_719`. Receiver `/peers` reports one pending message.
Write the `release` file from a third shell; the watcher releases the held
provider request. Receiver replies with `PEER_ACK_719`; sender wakes and reports
`SENDER_ACK_CONFIRMED_719`. Inspect the `*-requests.jsonl` files for peer source
and ordering. Exit both with `/exit`; their own live records disappear.

For the failure experiment use a fresh scratch root, export
`NAMZU_PEER_FIXTURE_FAIL_PEER=1` in both terminal shells, leave the receiver idle
and submit `SEND_PEER_719` on the sender. After the receiver error, send
`/peers send <receiver-ref> SECOND_PENDING_719`. It remains pending; receiver
`CONTINUE_719` admits a new operator turn that consumes the mail. The fixture
then deliberately fails the peer request again, with no stale pending row.

## Source comparison

`DECISION.md` pins repository revisions. Inspect the following primary files:

- Codex: `codex-rs/core/src/session/input_queue.rs`,
  `tools/handlers/multi_agents_v2/{send_message,followup_task,interrupt_agent}.rs`,
  `agent/control/delivery.rs`. V2 is disabled in the installed version; source
  observations do not claim that a default installed TUI ran these paths.
- Pydantic AI: `pydantic_ai_slim/pydantic_ai/_enqueue.py`,
  `capabilities/_pending_messages.py`, `_agent_graph.py`; completion drains can
  redirect to another model request instead of losing accepted pending input.
- Hermes: `tools/delegate_tool.py`, `delegate_tool_registry.py`; steering is
  consumed at boundaries and missed accepted steering is reported explicitly.

There is no single universal agent architecture standard. The selected terms
and contracts separate live process messaging, owned child tasks, reusable agent
identity, environment leases and durable workflows. A2A remains an external
adapter. Local peer acceptance supplies neither durable missions nor a Pal
product; those decisions remain in the existing Pals architecture document.

## Full local gates

The repository's 48-step runner is used, including workspace tests, process
tests, evals, coverage, metadata, consumer install, docs and every publint target.
The completed receipt and follow-up runs are in `artifacts/local-gates.json`;
`FINAL-AUDIT.md` maps each requirement to evidence. Native test instances are
all closed.
