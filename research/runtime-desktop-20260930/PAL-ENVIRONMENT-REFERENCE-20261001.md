# Pal identity and local environments: reference audit

Date: 2026-10-01. Status: research and selected implementation direction;
not an implemented Pal product. Namzu audit baseline: local `afd7ba4e`.
This supplements [Pals architecture](PALS-ARCHITECTURE.md) and
[recurring missions](RECURRING-MISSIONS.md).

## Scope and first release constraint

The operator explicitly selected **local devices only for the first Pal
computer/browser release**. Use a local supervisor, durable identities and
workspaces, local execution environments/browser profiles, explicit grants,
and user takeover. Cloud provisioning, remote service discovery and public A2A
endpoints are outside this first slice. A local Pal cannot continue executing
while its owning device or supervisor is unavailable. Saved state and access
grants can survive that outage; availability must be shown separately.

This audit read source, official public documentation and published UI images.
No external service, container, provider/model, user account, credential flow,
installation or live environment lifecycle was exercised. Published recordings
are author evidence; they are not a Namzu interoperability or latency test.

Pinned external sources:

- OpenDots: `8f53c3bb148068cf0405677de07df34cdfd2f680`.
  [Repository](https://github.com/CopilotKit/OpenDots/tree/8f53c3bb148068cf0405677de07df34cdfd2f680).
- Its computer implementation, OpenBot:
  `b6932d31a8d6e7896c15139dfc27a6c6911deb27`.
  [Build pin](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/deployment/computers/supervisor.Dockerfile).
- Official Dots product documentation, fetched 2026-10-01. These describe the
  OpenAI product; they do not describe the internals of either repository.

## What exists in Namzu

| Layer | Verified local state | Missing Pal product ownership |
| --- | --- | --- |
| Agent execution | SDK Agent/runtime, CLI delegated children, provider/model routing and bounded task activity | Durable reusable Pal identity and definition revisions |
| Child messaging | `Agent`, `send_message`, `wait_for_task`, cancellation and follow-up in an owned child conversation | Persisted Pal-addressed mailbox and delivery/recovery contract |
| Independent sessions | Local peer discovery and messaging between ready interactive terminals | Resident Pal service ownership; live terminal IDs are not stable Pal IDs |
| Desktop | Uses CLI/ACP runtime and shows conversations, jobs, approvals and child activity | Pal registry, assignments and environment/grant management |
| Persistence | Stores, checkpoints, task records and schedule records | One admitted Pal assignment tying definition, environment, authority and attempts together |
| Workflows | Dependency helpers and recurring-work primitives | Enforced durable prerequisite dispatch, joins and recovery for a recurring mission |
| Capabilities | Browser, computer-use and sandbox adapters | Pal-owned environment admission, lease fencing, credential lifecycle and takeover arbitration |

Evidence: [delegated work](../../docs/cli/delegated-work.md),
[peer messaging](../../docs/cli/peer-messaging.md),
[desktop](../../docs/cli/desktop.md),
[dependency helpers](../../packages/sdk/src/tools/coordinator/plan-dependencies.ts),
[disk task store](../../packages/sdk/src/store/task/disk.ts), and
[headless schedule construction](../../packages/cli/src/schedule/fire/fire.ts).

An accepted message is queued context, not a delivered instruction or completed
operation. Active child and peer mail enters the next valid provider request;
it does not splice into an in-flight tool/provider response. The peer inbox is
process-local until mail enters conversation history. Child task ownership and
independent terminal messaging remain distinct. Current headless construction
must also resolve the complete provider profile before groups can promise mixed
provider recurring work. These are reusable foundations; the Pal/group/lead
product layers are still planned. This audit made no remote or npm publication
check and establishes local state only.

## Official product behavior to learn from

### Computers, sessions and authority

The official product offers its own stateful cloud computer and a separately
authorized personal computer. Inspecting a computer and taking over its input
are distinct actions. Website credentials are entered through a private flow,
with active site sessions distinguished from saved-login reuse. Plugin account
access and messaging channels are separate permissions. Local availability and
revoked access are also separate states.
[Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps).

For Namzu, these distinctions inform the ownership contracts. The cloud
deployment behavior is not part of the operator's selected local first release.

### Tasks and continuity

The product documents parallel background agents, visible task conversations and
follow-up instructions. Tasks stay on their original environment. A new task
receives selected context; it does not inherit every conversation. Fixed
schedules, supported event monitoring and adaptive wakeups have different
contracts. Conversation context, persistent notes and account memory are
separate. One identity can span messaging channels while conversations and
disclosure permissions remain distinct. A completed run requires output review;
completion alone is not proof of delivery.
[Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory).

These are product observations, not a published specification of its internal
orchestration, transport or storage design.

## What OpenDots concretely implements

### Durable identity and scoped conversations

SQLite persists named Dot identities and explicit Space membership. A Dot's
default Space is a destination, not its owner. Conversation records bind a Dot
and the one configured owner; server lookup checks that binding. Roles and
instructions can therefore survive individual runs. The Dot record has no
per-Dot model/provider binding or pinned immutable definition revision. Runtime
model configuration is shared; enabled memory reads the owner's common memory
store rather than a private per-Dot namespace.
[Types](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/src/shared/types.ts#L65),
[identity and thread binding](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/src/server/workspace.ts#L117),
[agent configuration and memory](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/src/server/dot-agent.ts#L178).

### Per-identity computer persistence

The upstream supervisor derives separate container, workspace-volume and
browser-profile-volume names from the Dot ID. Stop retains storage; restarting
or replacing the container can reuse it. A persistent Chromium context retains
site sessions. This implements durable identity plus independently persistent
computer state; the application exposes start/stop/status, without a separate
allocation ID, generation fence or environment lease record.
[Resource naming](https://github.com/CopilotKit/OpenBot/blob/b6932d31a8d6e7896c15139dfc27a6c6911deb27/supervisor/src/names.ts#L67),
[creation and replacement](https://github.com/CopilotKit/OpenBot/blob/b6932d31a8d6e7896c15139dfc27a6c6911deb27/supervisor/src/docker.ts#L418),
[stop/reset](https://github.com/CopilotKit/OpenBot/blob/b6932d31a8d6e7896c15139dfc27a6c6911deb27/supervisor/src/docker.ts#L607),
[profile persistence](https://github.com/CopilotKit/OpenBot/blob/b6932d31a8d6e7896c15139dfc27a6c6911deb27/agent-computer/src/profiles.ts#L410).

### Computer authority and its limits

OpenDots derives a per-Dot computer bearer from a server-held master with HMAC,
binds the Dot ID at the gateway, and validates computer endpoints. Durable
gateway capability switches default off and are checked around requests.
Space membership does not union those permissions. The child API enforces its
bearer and takeover, while the application gateway enforces capability policy.
Revoking a gateway permission requests cancellation; it does not invalidate the
child bearer or expire website cookies. The documentation explicitly describes
the remaining-operation limits.
[Token patch](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/deployment/computers/harden-supervisor.mjs#L4),
[bound gateway and endpoint validation](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/src/server/computer-service.ts#L41),
[request policy](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/src/server/computer-service.ts#L319),
[permission defaults](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/src/server/computer-store.ts#L7),
[documented cancellation limits](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/docs/COMPUTERS.md#L51).

The template is single-owner. Its deployment token and Dot existence checks
are not a multi-user credential-grant system. Standard Docker confinement is
real, but shares the host kernel; the pinned image defaults to root and
Chromium disables its own sandbox. Separate volumes isolate application state,
without making mounted browser cookies inaccessible to guest code. Optional
upstream workload identity support is not the template's authorization gate.
[API principal](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/src/server/app.ts#L37),
[security scope](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/SECURITY.md#L3),
[container boundary](https://github.com/CopilotKit/OpenBot/blob/b6932d31a8d6e7896c15139dfc27a6c6911deb27/supervisor/src/docker.ts#L418),
[image](https://github.com/CopilotKit/OpenBot/blob/b6932d31a8d6e7896c15139dfc27a6c6911deb27/agent-computer/Dockerfile),
[browser flags](https://github.com/CopilotKit/OpenBot/blob/b6932d31a8d6e7896c15139dfc27a6c6911deb27/agent-computer/src/profiles.ts#L63).

### Recurring work is one conversation-bound instruction

Tasks persist a conversation binding and execute another turn in that thread.
Claims and results are lease-guarded; expired work is requeued. Each Runner
admits one background task at a time. Repeat intervals start after successful
completion, and ordinary failures become failed tasks. This is useful job
ownership/recovery code, not a parallel dependency graph, transactional external
side-effect executor or full goal/event system. The README explicitly identifies
multi-Dot group conversations and automatic delegation as future work.
[Task admission](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/src/server/app.ts#L88),
[same-thread execution](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/src/server/index.ts#L62),
[claims and finishing](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/src/server/store.ts#L192),
[runner](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/src/server/runner.ts#L43),
[stated scope](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/README.md#L184).

## Local Pal design: keep the selected boundaries

The earlier separation of identity, definition, assignment, environment and
grant remains appropriate. OpenDots demonstrates implementable pieces of that
split and identifies where a stronger Namzu contract is still needed. The first
release should avoid an unnecessary group hierarchy, distributed deployment
manager or second model orchestrator.

### Existing local adapters and truthful capability labels

| Mode | Available local foundation | Required product boundary |
| --- | --- | --- |
| Dedicated browser profile | `PlaywrightBrowserHost`, local profile leases, platform/WSL browser launch | Own the selected profile and input lane; profile state does not confine host files/processes |
| Operator desktop/window | Native X11, Wayland, macOS and Windows/WSL adapters; Windows cua-driver offers scoped-window capture/input | Explicit host access; existing adapters use the logged-in desktop rather than provisioning a private Pal desktop |
| Local process sandbox | SDK local provider detects bubblewrap, namespaces, Seatbelt or basic execution | Request required isolation and inspect the actual capability report; basic execution has none, Linux namespaces alone expose host files |
| Local container execution | Docker backend, controlled mounts, per-instance worker token and container hardening | Verify the configured engine is local; currently an execution/file worker, not an integrated private desktop/browser host |
| Private local VM | No ready OS-specific local VM/browser/desktop launcher established by this audit | Future adapter; current Firecracker client requires a separately operated orchestrator |

Evidence: [browser host](../../packages/browser/src/host.ts),
[browser platform and lease documentation](../../docs/sdk/browser-host.md),
[computer adapter selection](../../packages/computer-use/src/SubprocessComputerUseHost.ts),
[window adapter](../../packages/computer-use/src/adapters/cua-driver/adapter.ts),
[local sandbox](../../packages/sdk/src/sandbox/provider/local.ts),
[isolation capabilities](../../packages/sdk/src/sandbox/isolation.ts),
[Docker backend](../../packages/sandbox/src/backends/docker/index.ts),
[Firecracker contract](../../docs/sdk/firecracker-sandbox.md), and
[worktree semantics](../../docs/cli/worktrees.md).

Choose a supported mode per Pal and per platform. A directory/worktree isolates
checkout state, and a browser profile isolates application state. Neither is an
OS security boundary for arbitrary shell execution. A host-mode Pal must be
presented as using explicitly granted operator-device authority. Every Pal does
not need a VM; an isolated-computer claim needs an adapter that supplies the
claimed boundary. Do not silently fall back to weaker authority/isolation.

The native capability reports also differ: scoped windows/UI trees are not
declared by X11, Wayland or macOS adapters; macOS lacks scroll support, and the
Windows PowerShell fallback lacks cua-driver's window/UI-tree capabilities.
Admission must reflect the actual available adapter rather than a global
computer-use feature label.
[X11](../../packages/computer-use/src/adapters/linux-x11.ts),
[Wayland](../../packages/computer-use/src/adapters/linux-wayland.ts),
[macOS](../../packages/computer-use/src/adapters/darwin.ts),
[Windows fallback](../../packages/computer-use/src/adapters/win32-powershell.ts).

### Implementation order

1. **Save a reusable identity.** Host-owned `palId`, name, definition reference
   and revision, selected provider/model profile and state references. Keep SDK
   executable Agent construction in the composition root. Persist assignment
   IDs separately from conversations and execution attempts.
2. **Bind local resources at admission.** Resolve a supported local adapter and
   record workspace/profile/environment identity, owning device and a generation
   fence. An assignment retains that binding while UI selection changes. A
   profile change cannot redirect already admitted work. Concurrent browser or
   desktop owners acquire a resource lane; two group memberships do not create
   two owners of the same computer input.
3. **Keep credentials out of conversations.** Reference host-owned grants
   containing account/resource, allowed actions, audience and revocation state.
   Private sign-in uses the selected local browser or protected host surface.
   A valid browser session, permission to use it and a saved login are separate
   records. Group changes never merge credentials or private histories.
4. **Arbitrate human input.** Inspection is read access. Takeover suspends agent
   input for that resource; explicit return reacquires ownership. Cancellation,
   revocation, environment stop, logout and profile deletion have distinct
   effects. Report any already dispatched operation whose outcome cannot be
   confirmed; do not turn an abort request into proof of rollback.
5. **Recover honestly.** On supervisor restart, reconcile admitted attempts
   against actual local processes and resource generations. Reuse saved state
   only after checking current authority. Never blindly repeat an external
   mutation after losing its outcome. Show offline/unavailable, paused,
   waiting-for-input and revoked states distinctly.
6. **Add groups after individual Pals work.** Membership and lead are roles;
   the lead may use existing delegation. Bind one controller to each assignment.
   Add a durable workflow only for enforced dependencies, joins and retries.
   Cron admits an assignment from a saved revision; it does not recreate a team
   prompt and hope model prose enforces the graph.

Initial acceptance cases: identity/profile survive restart without restoring
revoked authority; selected computer changes do not move a task; two callers
cannot own the same input lane; takeover blocks agent input; cancellation and
stop report their actual effect; device outage exposes unavailable work; group
membership cannot expand account access. Delivery/results need explicit
receipts, separately from terminal execution status.

Device outage is different from an operator disabling a Pal while the host is
still online. Disabling must block admission and cancel/drain owned work before
releasing input leases/resources. Existing browser cancellation can reject a
caller while the underlying operation continues, and `keepOpen` can intentionally
retain the browser. An abort signal alone therefore cannot implement a promise
that all Pal activity has stopped. Shared attachments must remain available to
their other legitimate holders.
[Browser cancellation and disposal](../../packages/browser/src/host.ts).

A2A is an optional future exposure adapter. Existing Namzu wire conformance gaps
remain relevant before enabling remote callers, but repairing or provisioning a
public endpoint must not block this local-only Pal slice. See the protocol audit
inside [Pals architecture](PALS-ARCHITECTURE.md).

## Published UI assets inspected

All links below are pinned repository assets, not screenshots produced by this
audit. Seven static images were visually inspected. They support UI comparisons,
not runtime, permission, credential, orchestration or isolation claims.

| Asset | Visible evidence | Useful Pal UI pattern |
| --- | --- | --- |
| [Chat layout](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/docs/images/chat-layout.png) | Named agent, scoped conversation navigation, call receipt and composer | Keep identity and activity attribution visible |
| [Space library](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/docs/images/spaces-library.png) | Searchable document cards and disconnected setup state | Shared outputs are separate from conversations |
| [Space workspace](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/docs/images/spaces-workspace.png) | Document editing, save status and setup action | Output ownership/status should be explicit |
| [Chat-to-space poster](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/docs/demos/chat-to-space-poster.jpg) | Agent header, browser action receipt and inline computer view | Associate each tool result with its environment |
| [Page-chat poster](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/docs/demos/spaces-page-chat-poster.jpg) | Agent selection and saved-page context under a document | Show which bounded context an assignment receives |
| [Computer-chat poster](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/docs/demos/computer-chat-poster.jpg) | Completed browser tool card with the named computer's current view | Keep resource identity with tool activity |
| [Voice-call poster](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/docs/demos/voice-call-poster.jpg) | Agent identity, call timer, microphone state and transcript | Persistent identity can have several interaction surfaces |

The repository also publishes GIF/MP4 recordings for chat-to-space, specialist
chat, page chat, computer chat and voice call. README embeds public recordings
for [chat](https://github.com/user-attachments/assets/4c74fe7d-ecdd-42dd-95da-5d34f9b9576e),
[page chat](https://github.com/user-attachments/assets/d20c3405-4339-49e7-a799-43298728015c),
[computer use](https://github.com/user-attachments/assets/30b691c3-0f66-4964-9fdb-67d4feab5568),
[voice](https://github.com/user-attachments/assets/3c06cf71-39ed-4e2b-b846-5463b2722389)
and [Slack](https://github.com/user-attachments/assets/27d03a6c-a9e0-4c29-8d96-fafe0fbae20f).
No public hosted application link was identified in the inspected README;
the runnable template requires local setup.

Recording notes disclose trimming, playback acceleration, low frame rates and
silent exports, so they cannot establish real response time or micro-animation
quality. The README reports live checks by its authors while explicitly leaving
Slack and spoken compute delegation unverified. Those statements are not this
audit's execution results.
[Recording provenance and limits](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/docs/demos/README.md),
[README validation scope](https://github.com/CopilotKit/OpenDots/blob/8f53c3bb148068cf0405677de07df34cdfd2f680/README.md#L182).

The visual lesson is identity, resource attribution, bounded context and honest
setup/status surfaces. These references do not require replacing Namzu's chosen
rail/composer design or adding another product's branding to application code.

### Additional visual evidence captured by the root audit

Artifacts are outside Git at `/var/tmp/namzu-pal-visual-20261001/`:

- `dots-computer-card.png`: official documentation illustration, with a named
  computer, control owner and takeover action.
- `dots-private-signin.png`: official documentation sign-in illustration; the
  private credential form is separate from the conversation.
- `dots-tasks-and-memory.png`: official documentation task/activity/output
  presentation and composer alongside work in progress.
- `opendots-computer-10.png` and `opendots-computer-30.png`: frames from the
  published OpenDots computer demonstration, showing browser/tool receipts and
  file/terminal results inline.

The root agent captured and inspected these five images. They are public
documentation/recording evidence, not a live signed-in Dots or OpenDots account
test. This agent inspected the seven repository images listed above separately;
both visual sets inform UI ownership/attribution, without establishing private
service functionality or Namzu end-to-end capability.
