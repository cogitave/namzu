# Live child workflow and direct operator messages

Observed on 2026-10-01 in the actual installed interactive Claude Code 2.1.286,
using Sonnet 5.5 through Claude Max. This is live provider evidence, not a
scripted model. Safe mode disabled customizations; built-in tools remained
available. Only a fresh owned scratch project and conversation were used.

Evidence: [selected original records](artifacts/claude-child-workflow-observations.json),
[parent acceptance](artifacts/claude-child-parent-queued.txt),
[child during the blocking tool](artifacts/claude-child-running.txt),
[direct child input queued during work](artifacts/claude-child-direct-queued.txt)
and [parent after the follow-ups](artifacts/claude-child-parent-final.txt).
The raw terminal capture remains in the scratch directory. Selected screens
exclude the global session picker and unrelated session records.

## Experiment

The parent launched exactly one background child for a two-stage workflow:
a synchronous 120-second Bash command followed by an ALPHA validation.
The Bash call explicitly set `run_in_background: false` and a 180-second
timeout. Its command appeared once in the child's actual tool records.

| UTC event | Time | Evidence |
| --- | --- | --- |
| Blocking Bash requested | 07:00:45.662 | Child tool call |
| Parent forwards a correction with SendMessage | 07:01:47.942 | Parent tool call |
| Message accepted for the next tool round | 07:01:47.950 | Actual tool receipt |
| Blocking Bash completes | 07:02:46.546 | Matching child tool result |
| Child runs BETA instead of ALPHA | 07:02:48.156 | Actual second Bash call |
| Corrected result handed back | 07:02:50.563 | SubagentHandback |

The correction was accepted while the tool was in flight. It did not cancel
or interrupt that command. The same child changed its second stage at the
next boundary and returned `CORRECTED_WORKFLOW_719`. There was one launch,
one execution of the 120-second command, and no ALPHA command execution.
This establishes the boundary behavior that the earlier background-shell
experiment could not establish.

## Direct child composer

The original TUI can select the child and shows `Message @general-purpose…`.
The agent rail shows live tool activity, elapsed time and a queued-message
count. Selection management owns Enter until it is dismissed; entering text
there is a draft, not proof of a submitted message. This experiment initially
left the direct-message draft in selection management. It was submitted only
after leaving that mode, after the first workflow had completed.

That direct idle message resumed the same child and produced another handback,
without another Agent launch. A subsequent direct follow-up in that same child
ran one additional, explicitly requested synchronous 60-second command. While
it ran, an operator correction was submitted through the child composer.
The actual screen showed `1 queued`. After the tool returned, the child handed
back `UI_BUSY_CORRECTED_719`, rather than the original marker. Thus both idle
follow-up and direct busy input were established separately.

The parent received those later results and further completion notifications.
However, its request history did not contain the directly authored child
instructions. It questioned the changed markers and asked whether the operator
had sent those messages. Direct delivery works; automatic parent awareness of
the operator's changed assignment did not follow from it in this experiment.
This is a useful coordination gap to avoid copying into a host implementation.

## Mapping onto Namzu

| Path | Current Namzu contract | Verified extent |
| --- | --- | --- |
| Parent to an owned child | `send_message` resolves the turn's task gateway, calls `continueTask`, and records acceptance. The manager stamps `inboundMessages`; query-backed children drain it at provider-valid boundaries. | Same delivery boundary as the original; acceptance is not reading. Finished tasks are refused. |
| Normal versus Hypermode delegation | Both call the existing `Agent` tool and `createSubagentRuntime`. Hypermode changes effort and model guidance. Workflow and phase labels are display annotations. | Shared child execution and message path; labels do not impose dependency barriers. |
| Operator directly to a selected child | The current child transcript captures navigation keys and hides the ordinary composer. It has no direct child message action. | UI parity is absent. A model-mediated parent correction is not a direct operator composer. |
| Follow up after child completion | The current `send_message` refuses a terminal task. Saved child replay is read-only. | Same-identity idle follow-up needs a separate operation and lifecycle; it cannot be described as sending to a still-running task. |
| Independent terminal to terminal | `send_session_message` uses live peer identity and authenticated local transport, with separate provenance and host admission. | Already implemented; it does not address child tasks. |

Code inspected: `packages/cli/src/integrations/subagents/runtime.ts`,
`packages/cli/src/integrations/subagents/NamzuCliAgent.ts`,
`packages/cli/src/tui/agent.ts`, the child-surface input/render branches in
`packages/cli/src/tui/App.tsx`, `packages/sdk/src/manager/agent/lifecycle.ts`,
`packages/sdk/src/agents/QueryAgent.ts` and the query loop's `deliverInbound`.
`ultracode` is not an active Namzu composer trigger or provider effort alias;
the session mode is Hypermode.

## Architecture consequences

Keep peer identity, owned task identity and persistent agent identity separate.
A direct operator composer should route to the exact selected live child, with
explicit queue acceptance and unchanged review authority. Its admission also
needs an attributed assignment-change event available to the parent, rather
than asking the parent to trust a child's claim that the operator changed its
task. That event is evidence of input, not a claim of completed work.

A completed child's follow-up is a new invocation associated with an existing
conversation or persistent identity. It requires fresh run ownership, budgets,
cancellation and authorization. Do not reactivate a terminal task through
`continueTask`, and do not repurpose the independent terminal peer transport.
The current communication foundation matches delivery rules; it does not yet
provide the two additional child UI/lifecycle operations above.

## Closure and checks

The interactive capture exited with code 0. Navigating to the original CLI's
global selector automatically created a background copy in the same owned
scratch project; that exact copy was stopped. Discovery for that project then
returned no live sessions. No existing user conversation was resumed or stopped.

Scoped SDK manager/query boundary tests passed: two files, ten tests.
Scoped CLI background/message and composer-mode tests passed: two files,
thirteen tests. They use controlled providers and do not replace the live
original-provider evidence above. No production behavior was changed by this
follow-up investigation.
