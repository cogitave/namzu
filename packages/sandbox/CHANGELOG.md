# @namzu/sandbox

## 2.0.2

### Patch Changes

- ee1aa38: Remove references that pointed readers at a directory they can never open.

  Agent working memory in this repository is gitignored, and several published
  artifacts cited paths inside it. None of them resolved for anyone but the
  maintainer, and four cited session folders that no longer exist at all.

  What a consumer sees change:

  - `@namzu/sandbox` raised `Sandbox backend 'x' is not implemented yet. Track
progress in vendor/namzu/docs.local/sessions/ses_004-...` — a runtime error
    instructing the reader to open a path that is not in the package, not in the
    repository, and not on the internet. It now names what does ship instead.
  - `@namzu/computer-use`'s README linked to an adapter-pattern document under a
    directory that does not exist in any checkout. It now links to the two
    published pages that actually carry the adapter contract, the capability
    protocol, and the platform command matrix.
  - `@namzu/cli`'s README linked to a session folder on the code host that
    returns 404, to explain the doctor's protocol/runtime split. The split is now
    explained in the sentence itself.
  - `@namzu/sdk` source comments cited design documents by path. They cite the
    session by name instead, which is what the reference was ever worth.

  No API, type, or behaviour change. The `@namzu/sandbox` message text is the
  only runtime string affected, and nothing asserts on it.

## 2.0.1

### Patch Changes

- 4be54ca: Three sandbox and delegation gaps, all of the same kind: something declared,
  threaded through types, and never driven.

  **`SandboxExecOptions.signal` now works — on the backend where it can.** The
  option was declared, documented and exported, with a docstring stating that
  without it "a Stop could only ever abandon the _wait_ — the sandboxed process
  kept running after the host believed the run had been cancelled". Every
  backend dropped it, so that is exactly what happened. The local sandbox now
  merges the caller's signal with the call's own deadline and hands the result to
  `spawn`, so the child actually dies; a cancelled run is no longer reported as
  `timedOut`, because a run someone stopped did not run too long, and telling the
  model otherwise invites a retry with a bigger budget.

  The remote backends still ignore it, now explicitly and with the reason in the
  source. Their wire has no cancel op, so aborting the request would abandon the
  wait while the command kept running — the original failure, wearing the
  appearance of a fix. `SandboxExecOptions.signal` documents which backends
  honour it.

  **`ls` respects the sandbox.** It read the host through `node:fs` and named
  `context.sandbox` nowhere, in the one builtin whose whole job is telling the
  model what exists — so under a container or microVM backend the model's picture
  of the filesystem was the host's. Its paths were host-relative too, while
  `read`, `grep` and `glob` all resolve inside the sandbox, so an ls-to-read
  handoff either failed or opened a different file than the one listed. `glob`
  had the identical defect, was fixed, and its fix notes that "every sibling
  builtin already remembers this branch"; this was the sibling that did not.

  One behaviour difference worth knowing: inside a sandbox, directories are
  derived from file paths, because `listFiles` reports files. An empty directory
  is invisible there.

  **The `Agent` tool's header described a design that no longer exists.** It told
  readers to prefer `Agent` because `create_task` was a non-blocking trio driven
  by notification callbacks. `create_task` blocks and returns the worker's output
  as its own result, and `continue_task` / `cancel_task` are not registered at
  all. The two tools are separated by how much of the coordinator surface they
  bring, not by timing.

## 2.0.0

### Major Changes

- 935b8f3: **Breaking:** `@namzu/sandbox` declares only the backends it has.

  Four of the shapes this package offered could type-check and then throw: a `process` tier, a `passthrough` tier, and two adapters to third-party managed schedulers, none of which was ever written. Each demanded required configuration for a call that was never made — the `self-hosted` microvm arm went further and required three fields belonging to a local-daemon path that does not exist, while the two fields the working path needs were optional. So the only configuration that ran had to supply three values nothing reads, and omitting the two that matter compiled its way to a runtime throw.

  `SandboxTier` is now `container | microvm`. `MicroVMBackendConfig` is one shape whose `orchestratorEndpoint` and `getToken` are required. `SandboxBackendNotImplementedError` stays exported and thrown: a JS host that invents a tier gets a named refusal rather than a provider that confines nothing.

  The `sandbox.platform` health check now asks the provider what this host enforces instead of answering from a table keyed on the OS name. That table had drifted both ways — it called the Linux probe unimplemented long after the provider began probing real flags, and it told a Windows operator that sandboxing is "not supported", which is true of the in-process tier and silent about the container tier that runs there. Every non-passing result now names the missing controls and what to do about them.

  `SANDBOX_ISOLATION_CONTROLS` is exported as a value from `@namzu/sdk`. It was reachable only through `export type *`, so importing it type-checked and then failed on the first line of a built binary.

### Minor Changes

- 935b8f3: The two gaps that were deferred as needing their own design session.

  **A question raised inside a tool is now durable, and the answer reaches
  the tool that asked.** `ask_user_question` parked through the raw handler
  under a synthetic `cp_question_<toolUseId>` id that was never written
  anywhere. The checkpoint did not exist: nothing on disk said a human owed
  this run an answer, the pending-checkpoint lookup could never return it,
  and a remote host could not even _observe_ the question except through the
  in-process callback. Kill the process while somebody is looking at the card
  and the answer could never be applied — the restore path stripped the whole
  assistant turn, discarding work that sibling tools in the same batch had
  already finished, and re-billed the turn.

  The park is now a real checkpoint, with `user_question_asked` /
  `user_question_answered` on the event stream, `question.asked` /
  `question.answered` on the SSE wire, and an `input-required` A2A status —
  the same surfaces a tool-review park has always had.

  The re-entry contract was the deferred half, and it turned out to reuse
  machinery that already exists. A question checkpoint is written
  mid-execution, so it holds the assistant turn with its `tool_use` blocks
  unanswered — the same shape a tool-review park leaves. Re-executing that
  batch is _how_ the asking tool gets re-entered; a carried-answer registry
  is what makes the re-entry return the recorded answer instead of parking a
  second time; and every sibling that already completed is answered from the
  transcript by the crash-resume recovery, so nothing runs twice. An answer
  that does not name a call in this turn is refused rather than delivered to
  whichever tool now holds that slot.

  **The egress policy has a boundary to be enforced at.** Two of its four
  shapes were honourable nowhere: the container backend refused a host
  allowlist outright because it had nothing to filter through, so `deny-all`
  and `allow-all` were the whole spectrum — all or nothing.

  `EgressProxy` enforces the other two. Matching has exactly two forms —
  exact host, and `.example.com` for a domain and its subdomains — and
  substring is deliberately not one of them: `host.includes(entry)` would
  admit `example.com.attacker.net`, and plain suffix matching would admit
  `notexample.com`. A policy that cannot be read denies, because an allowlist
  that fails open is not an allowlist. A request addressed to the proxy
  itself is refused rather than forwarded — found by a test that hung instead
  of failing, which is exactly the shape that failure takes in production.

  `Sandbox.setNetworkPolicy` narrows or widens a **live** sandbox, so "clone
  with a token, then drop to deny-all before running untrusted build scripts"
  is expressible; it was not, because the policy was frozen at provider
  construction. A backend that cannot enforce it throws.

  And `brokeredCredentials` settles where the token lives. Any credential the
  agent needed to reach an allowed host had to be inside the sandbox, in the
  environment, readable by the untrusted code it is meant to be isolated from
  — via `/proc/self/environ`, or via a prompt injection that exfiltrates it
  over the very egress the policy permits. The real value is now held
  host-side and applied at the boundary, scoped per host: a credential
  attached to every request is a credential handed to whichever host the
  agent was talked into contacting.

  One limit, stated rather than hidden: a credential cannot be injected into
  a CONNECT tunnel, because reading those bytes would mean terminating TLS
  with a CA the sandbox trusts — a strictly larger risk than the one being
  mitigated. A workload that needs brokering speaks plain HTTP to the proxy
  and lets it upgrade upstream. The allowlist is enforced on CONNECT either
  way, since the target names the host in clear text.

- 935b8f3: Two blast-radius controls that were accepted and silently dropped.

  **The standby-pool backend discarded every per-sandbox control.** Its create
  function took its options parameter underscore-prefixed and never read it,
  and the request body it assembled carried no resources, no environment
  variables and no network policy — while the provider faithfully assembled
  all of them first. A host that set `deny-all` and a 512 MB cap got full
  outbound network, no memory cap and no process cap, with no error and no
  warning, from the same call shape that **is** enforced on the sibling
  container backend. Switching backends silently removed the controls.

  The claim API rejects every property override except a config map, so these
  genuinely cannot ride through per sandbox — which makes refusing the honest
  fix rather than a missing feature. It now throws, naming every field it
  cannot honour rather than the first, and saying where the limits do belong
  (the container group profile the pool is built from). namzu already held
  this norm next door, with the rationale in that backend's own comment: a
  policy accepted and quietly ignored is worse than one that is refused.

  **`allow-all` and `resolver` encoded identically on the microVM backend.**
  Both resolved to an omitted allowlist, so one encoding carried two opposite
  intentions — and the `resolve()` callback that produces a tenant-scoped list
  was never invoked anywhere in the repo. Whichever way the orchestrator reads
  an omitted field, one of the two was always mis-enforced, and the one that
  failed **open** was the one whose entire purpose is restriction.

  Each variant now has its own encoding: `allow-all` omits, `deny-all` sends
  an explicitly empty list, `static` forwards its hosts, and `resolver` calls
  `resolve()` and forwards the result — including an empty result, which is a
  real deny-all and not an absence. The switch is exhaustive, so a new variant
  fails to compile rather than falling through to unrestricted, and a resolver
  that throws propagates instead of degrading to open.

  The README's backend-by-policy table was wrong in both directions and is now
  accurate. Neither backend had a test directory; both do now.

### Patch Changes

- 935b8f3: Four defects an adversarial audit confirmed

  **A task could be created and then never found again.** `DiskTaskStore` writes under the run that created it and read only under the store's default run, so every lookup missed as soon as the two differed — the normal case, since the task tools are built with the live run id while a long-lived host constructs the store once with a fixed default. `create` succeeded, `list` succeeded, and `update`, `delete`, `claim` and every dependency link answered "not found" for a task the caller could see. The in-memory store keys by task id alone, which is why nothing caught it.

  **A sub-agent's token reservation was never returned.** The debit at spawn reserves headroom so siblings cannot each be promised the same tokens, and nothing credited back the unused part — so a pool shrank by the full allocation on every spawn no matter what the child used. At a half-pool fraction, ten delegations left a parent with a thousandth of its budget and the next spawn was refused for a budget that had barely been spent. The debit also ran before provisioning, so a spawn rejected for capacity still burned its allocation — the one state change the comment there promised would not happen.

  **A failed sandbox create leaked a proxy holding real credentials.** The egress proxy starts before the container and its only close was in `destroy()`, which a create that never returned can never reach. Every failure in between left a listening server on loopback stamping credential headers, plus a retained event-loop handle, one per retry.

  **A remembered approval could overrule the operator.** The grant check ran before the verification gate and returned, so a remembered approval skipped the gate entirely — and because a tool-scoped grant matches any arguments, approving one harmless invocation authorised every other one, past a rule written to stop exactly that. The gate now runs first, and a grant can satisfy a review but never a denial.

- 935b8f3: Stop dropping tool-failure status on Bedrock, and stop accepting a sandbox
  egress policy this backend cannot enforce.

  - **Bedrock** flattened every failed tool result into an ordinary success.
    The executor computed `isError`, the SSE and A2A bridges carried it, and
    the driver dropped it — even though Converse has a first-class
    `toolResult.status`. The model's trained tool-failure recovery path keys
    off that field, so namzu was relying on prose formatting to convey "that
    call failed".

    Scope note: the five OpenAI-shaped drivers are NOT affected, because
    Chat Completions has no error field on a tool message at all. The error
    reaches those models inside the result text, which is the only channel
    the protocol has.

  - **Docker sandbox** accepted `EgressPolicy` and silently ignored it. A
    host that set `deny-all` believed the container had no network and it had
    whatever `network` was configured. A security control that is accepted
    and ignored is worse than one that does not exist. Now: `deny-all` maps
    to `--network none` (which Docker enforces natively), `allow-all` keeps
    the configured network, and `static` / `resolver` **throw** — this
    backend has no proxy to filter hosts through, and downgrading a
    restrictive policy to "allow everything" is exactly the failure worth
    refusing.

  - **Docker sandbox** containers now run with `--cap-drop=ALL` and
    `--security-opt=no-new-privileges`, plus an opt-in `runAsUser`.
    `CAP_DAC_OVERRIDE` alone walks past the read-only bind mounts the layout
    sets up, and without `no-new-privileges` a setuid binary in the image
    re-escalates.

- 935b8f3: Five places where namzu gave up, or claimed to recover, too early.

  **A transient failure now pauses instead of failing.** A 503 that survived
  every in-turn recovery — retry with jitter, the one-shot compaction relief,
  mid-stream salvage — settled the run as `failed`, identically to a bad API
  key. The host could not tell them apart, and recovering meant knowing about
  checkpoints and driving replay itself. The state was never the problem:
  checkpoints are written every iteration by default and the failed run is
  persisted with full messages. Only the settle and the signal were missing.

  A retryable failure with a checkpoint to resume from now emits `run_paused`
  naming that checkpoint, leaves the span OK rather than ERROR, and sets
  `stopReason: 'paused'`. Both conditions are required — pausing on a
  permanent error would invite a resume that cannot work, and pausing with
  nowhere to resume from produces a run nobody can ever pick up.

  **A forced compaction pass can no longer decline to do anything.** A forced
  pass runs because the provider _rejected_ the prompt as too long, and two
  things let it treat that as advisory. It re-applied the chars/4 estimate
  after clearing stale tool results — the estimate the provider had just
  refuted — and returned early if that said the context was fine. And relief
  reported success on ANY positive shed, so clearing one short result counted
  and the retry burned a whole model call to be told the same thing. The
  early return is now force-gated, and a shed has to clear a floor (a
  fraction of the prompt, at least a couple of thousand characters) to count.

  Separately, the relief latch is per **stuck point**, not per run. It exists
  to stop a second overflow immediately after a successful compaction from
  looping; as a run-scoped flag it meant one relief at iteration 3 disarmed
  the mechanism for the rest of the run, leaving iteration 40 to die with
  obvious moves left. It is now cleared by a turn that actually succeeded.

  **An eval case can no longer hang the suite.** `executeCase` was a bare
  await, so a `run` closure that never settled blocked its worker and
  `runExperiment` never returned — no report, no partial results, nothing to
  read. `ExperimentConfig.timeoutMs` bounds a case and hands `run` an
  `AbortSignal` as a third argument; a timed-out case is reported and the
  suite continues, exactly like a case that threw, with its real elapsed time
  rather than zero. Unset means no deadline, which is today's behaviour. The
  documented path already inherits deadlines from the runtime it drives; this
  covers what those cannot see — a closure that does not go through
  `query()`, and a mid-iteration provider stall.

  **A malformed content block is named, not smuggled.** One driver built an
  image block by calling `String()` on whatever `data` and `mediaType`
  happened to be, behind only a truthiness check — so a non-string `data`
  became the literal `"[object Object]"` as the base64 payload, and the wire
  rejected the whole request with nothing naming the block at fault. That is
  reachable: a remote tool result is cast without validation on the way in.
  It now type- and media-type-guards and degrades to a named placeholder,
  matching the sibling driver that already did, and without inlining the
  payload it refused to send.

  **Failures have somewhere to grow remediation.** A stale API key surfaced
  as whatever prose the vendor SDK happened to write: no id to grep in logs,
  no instruction on what to change, and no growth point — a newly-observed
  failure shape could only be given curated copy by editing the classifier.
  `explainError` adds an ordered, id-keyed rule layer matching on
  **structural** signals (code, status, an explicit hint) rather than
  volatile vendor prose. `run_failed` carries the result as `explanation`;
  `withHint(err, '…')` lets a throw site attach what only it knows, and
  outranks every generic rule. It returns `null` when no rule claims the
  failure — inventing advice for something uncharacterised is worse than
  saying nothing, because it sends the reader somewhere specific and wrong.
  The container backend's readiness, port-mapping and worker-fetch failures
  now carry hints.

- 935b8f3: Close every open code-scanning finding

  **Breaking:** `LocalExecutionContext.executeCommand` no longer interprets its arguments as shell syntax. `shell` defaulted to `true`, and spawning with a shell re-joins the command and its argument array into a single `sh -c` string — so every metacharacter inside an argument became syntax. An `args` array reads argv-safe and was not. The default is now `false`; `shell: true` remains available where a caller genuinely wants a pipeline. A consumer passing `"ls -la"` as one command string, or relying on glob expansion without asking for a shell, must now pass `shell: true`.

  **A sandbox timeout is bounded, and an out-of-range one is refused.** The bash tool's `timeout` argument is a number the model writes, with no ceiling of its own, and it reached both sandbox transports unmodified — so a single call could pin a container or a guest for as long as the platform's timer honours. Both transports now refuse a non-finite, non-positive or over-thirty-minute request rather than clamping it: running under a deadline the caller never chose, and never learns about, is the "accepted and silently not applied" failure this codebase treats as worse than not offering the control at all.

  **Seven quadratic-backtracking regexes are now linear scans**, each on a path an attacker can reach: shell output the agent captured, a tenant-supplied connector URL, a host-supplied workspace root, a model completion, and three endpoint strings that cross the same trust boundary. The worst measured over thirty seconds on a single pathological input, on a shared event loop. Three of the seven were not flagged by the scanner — the same pattern, the same boundary — and were fixed with the rest rather than left to be rediscovered.

## 1.1.0

### Minor Changes

- ff1e013: Add an additive control-plane mTLS dial to the Firecracker backend.

  `FirecrackerBackendInternalConfig` gains an optional `controlPlaneMtls`
  (`{ ca; cert; key; servername? }`, the SAME shape as the relay's `mtls`). When
  present, the orchestrator control-plane calls — `POST /sandboxes`,
  `DELETE /sandboxes/{id}:delete` — dial over a `node:https` request that presents
  the client cert and verifies the orchestrator's server cert against the injected
  CA (`rejectUnauthorized: true`, `minVersion: TLSv1.3`), INSTEAD of the plain
  global `fetch`. This secures the control plane when `orchestratorEndpoint` is an
  `https://` URL reached over the PUBLIC internet (the non-VNet-integrated
  caller→FC-host hop), where the shared-secret bearer alone would be exposed on
  the wire.

  The change is purely additive and opt-in: with no `controlPlaneMtls` injected,
  the EXISTING plain-`fetch` control-plane path runs byte-for-byte unchanged (the
  single-host live proofs + local dev). The shared-secret bearer is still sent in
  both modes — mTLS is defense in depth on top, not a replacement. `node:https` is
  used rather than a `fetch` + undici dispatcher because the package declares no
  undici dependency; `node:https` is always importable and adds nothing. The cert
  material is injected by the consumer's runtime (mirrors `getToken` and the relay
  `mtls`), so the package still reads no keys from disk and stays Azure-SDK free.

- 208d415: Add an `mtls` arm to the Firecracker agent transport for the cross-host
  client-proxy bridge.

  `SandboxAgentHandle` gains a third variant —
  `{ kind: 'mtls'; host; port; sandboxId; tls: { ca; cert; key; servername? } }` —
  alongside the existing `unix` and `vsock` arms. When the orchestrator runs on a
  different host from the caller (the owned-fleet production path), the host-local
  `v.sock` is unreachable over the network, so the dialer instead `tls.connect()`s
  to a per-FC-host mTLS relay, writes a `SANDBOX <sandboxId>\n` preamble, and then
  runs the IDENTICAL length-framed NDJSON loop. The relay terminates mTLS and
  bridges to the jailed `v.sock` (issuing the guest `CONNECT 1024` handshake
  itself), so one inbound mTLS connection maps to one fresh local `v.sock`
  connect — preserving the resume-survival property of opening a fresh connection
  per request.

  The change is purely additive: the `unix` and `vsock` arms and all framing,
  heartbeat, and reconnect-on-resume code are byte-for-byte unchanged (single-host
  deployments keep using `vsock`). The TLS material is injected by the consumer
  (never returned by the orchestrator), keeping the package free of any key
  management.

- 74a1198: Add the owned-Firecracker microVM backend (`microvm:self-hosted`) and its
  host-side vsock transport.

  The `MicroVMBackendConfig` `self-hosted` arm gains the owned-platform seam:
  `orchestratorEndpoint` + `getToken` (the ACI `getArmToken` closure pattern, so
  the package keeps zero Azure-SDK deps) route to a new `backends/firecracker/`
  backend instead of throwing `SandboxBackendNotImplementedError`; `template`
  selects the golden snapshot revision and `agentVsockPort` /
  `readyTimeoutMs` / `readyPollIntervalMs` tune the agent dial. The legacy local
  `firecracker-containerd` shape (the three image fields alone) still throws.

  The backend is a sibling of `docker/` and `aci-standby-pool/` and a
  remote-copy backend like ACI (workspace seeded by archive-sync over the control
  channel, no host bind-mounts). It speaks the SAME NDJSON exec-stream + base64
  file-IO wire as the docker/ACI HTTP worker — only the transport differs:

  - One wire contract, factored into `backends/firecracker/protocol.ts`
    (`ExecRequest`, the `stdout_delta`/`stderr_delta`/`result`/`error` `ExecEvent`
    union, `ReadFileRequest`/`WriteFileRequest` + responses, the
    `ExecResultAccumulator` and `parseExecLine` the docker loop inlines today).
  - Two transports: HTTP for docker/ACI (UNCHANGED), and a NEW framed-over-vsock
    transport for FC (`backends/firecracker/transport.ts`), because across an FC
    snapshot resume a TCP control channel is dead-on-arrival while the vsock
    LISTEN socket survives (FC `snapshot-support.md`). Node `fetch` cannot dial
    AF_VSOCK, so the dialer, length-framing, heartbeat, and the
    reconnect-on-resume hardening (per-attempt connect/handshake timeout + retry
    budget to survive the FC #4713 `TRANSPORT_RESET`-not-delivered hang) are new.

  New public exports from `@namzu/sandbox`: `VsockAgentTransport`,
  `SandboxAgentHandle`, `VsockTransportOptions`, `FirecrackerBackendInternalConfig`,
  `OrchestratorTokenProvider`. The in-VM agent source (`agent/agent.cjs`, a vsock
  server reusing the worker spawn/jail + NDJSON shapes verbatim with the mandatory
  pre-ready entropy reseed) ships in the repo as a golden-rootfs build input,
  mirroring how `worker/server.js` is baked into the docker image — it is not a
  published runtime dependency.

### Patch Changes

- 0d1fb7b: Harden file intake and ACI readiness failure handling.

  The built-in read tool now guides Office and PDF packages through
  extractor tooling instead of treating binary document containers as
  UTF-8 text. The ACI Standby Pool backend now deletes a claimed
  container group when IP or worker readiness polling fails before a
  Sandbox handle is returned.

## 1.0.0

### Major Changes

- 8fd9349: feat(sandbox)!: Anthropic-style multi-mount container sandbox layout

  Adds a declarative `ContainerSandboxLayout` shape that maps onto
  Anthropic's container architecture (Claude container blueprint,
  Code Interpreter, "skills"). The `Container` prefix is load-bearing
  — this layout is specific to the container tier; future microVM /
  process tiers will carry their own layout types when their adapters
  land. Layout is supplied at provider construction — not per
  `provider.create()` call — so the type system catches missing-layout
  mistakes at compile time:

  ```ts
  import {
    createSandboxProvider,
    SANDBOX_DEFAULT_OUTPUTS_PATH, // re-exported from @namzu/sdk
  } from "@namzu/sandbox";

  const provider = createSandboxProvider({
    backend: { tier: "container", image: "namzu-worker:latest" },
    layout: {
      outputs: {
        source: {
          type: "hostDir",
          hostPath: "/var/lib/vandal/sessions/<task>/outputs",
        },
      },
      uploads: {
        source: {
          type: "hostDir",
          hostPath: "/var/lib/vandal/sessions/<task>/uploads",
        },
      },
      skills: [
        {
          id: "pdf-tools",
          source: { type: "hostDir", hostPath: "/opt/skills/pdf-tools" },
        },
      ],
    },
  });
  ```

  Each mount carries a discriminated `ContainerSandboxMountSource`.
  The single variant today is `{ type: 'hostDir'; hostPath: string }`;
  future variants (squashfs skill bundles, managed volumes attached
  to a container backend) land additively as minor bumps without
  reshaping the consumer call site.

  Layout fields and their defaults:

  - `outputs` — RW. Default `/mnt/user-data/outputs`. **Required**.
  - `uploads` — RO. Default `/mnt/user-data/uploads`.
  - `toolResults` — RO. Default `/mnt/user-data/tool_results`.
  - `skills` — RO list, default `/mnt/skills/<id>` per entry.
  - `transcripts` — RO. Default `/mnt/transcripts`.

  The defaults are exported as constants from `@namzu/sdk`'s root
  barrel (`SANDBOX_DEFAULT_OUTPUTS_PATH`,
  `SANDBOX_DEFAULT_UPLOADS_PATH`, `SANDBOX_DEFAULT_TOOL_RESULTS_PATH`,
  `SANDBOX_DEFAULT_TRANSCRIPTS_PATH`, `SANDBOX_DEFAULT_SKILLS_PARENT`)
  and re-exported from `@namzu/sandbox`, so prompt-template generators
  and the backend agree on a single source of truth. Both import
  paths (`@namzu/sdk` and `@namzu/sandbox`) are pinned by tests.

  There is intentionally **no `scratchpad` field**: the
  container-internal RW area (`/home/<imageUser>`) is image-bake
  responsibility, not a runtime knob.

  **Validation** runs synchronously inside `createSandboxProvider` and
  collects every violation in one
  `ContainerSandboxLayoutValidationError.reasons[]`:

  - `outputs` must be present.
  - Skill IDs match `/^[a-zA-Z0-9_.-]+$/`, and `id.includes('..')` is
    rejected (path-traversal guard — covers `..`, `foo..bar`,
    `..foo`, `foo..`). Isolated dots (`pdf-tools.v2`) pass.
  - Skill IDs are unique.
  - Resolved `containerPath`s are unique across every mount slot.

  **Error transport.** `ContainerSandboxLayoutValidationError`
  carries a `cause` field (Error native), `toJSON()` keeps `reasons`
  (and `cause` when set), and a new helper
  `serializeSandboxError(err: unknown): SerializedSandboxError`
  returns a plain object that survives `structuredClone`,
  `postMessage`, and `JSON.stringify` round-trips uniformly. The
  helper is **cycle-safe** — a `WeakSet`-threaded recursion detects
  self-cycles (`a.cause = a`), two-node cycles (`a.cause = b;
b.cause = a`), and longer loops, replacing the offending node with
  a `{ name: 'CircularReference', message: '[circular]' }` sentinel
  rather than overflowing the stack. The helper is also
  **transport-safe** — non-Error causes (Function, Symbol, BigInt,
  NaN, ±Infinity, undefined, null, primitives, plain objects) are
  converted to a typed envelope by `serializeNonErrorCause` BEFORE
  they enter the wire shape, so values that `JSON.stringify` drops
  silently or `structuredClone` throws on never appear.
  `SerializedSandboxError.cause` is strictly typed
  `SerializedSandboxError | undefined`. Use the helper at any
  worker / IPC / log-shipper boundary; cloning the Error subclass
  itself is not supported.

  **Breaking changes** — the legacy single-mount paradigm is removed:

  - `SandboxCreateConfig.hostWorkspaceDir` is removed. Pass the host
    path on `layout.outputs.source.hostPath` at provider construction.
  - `ContainerBackendConfig.workspaceMount` is removed. Pass the
    in-container path on `layout.outputs.containerPath`.
  - `SandboxProviderConfig` is now a discriminated union: the
    container variant requires `layout: ContainerSandboxLayout`, the
    other variants do not carry the field. Constructing a docker
    provider without a layout fails at compile time.
  - `SandboxCreateConfig.layout` does NOT exist; layout is
    factory-baked. The SDK runtime cannot accidentally call a
    container provider without a layout.
  - The docker backend no longer allocates host directories
    (`mkdtemp`) or removes them on `destroy()`. Every bind source is
    consumer-owned. This also fixes an `EACCES: permission denied,
mkdir '/Users'` crash that hit sibling-container deployments
    (Vandal Cowork).
  - The worker no longer reads `NAMZU_SANDBOX_LAYOUT` (it never
    branched on the env, only logged it; size grew with the skill
    list). Only `NAMZU_SANDBOX_WORKSPACE` is forwarded today.

  The reference Dockerfile pre-creates **only the parent directories**
  `/mnt`, `/mnt/user-data`, `/mnt/skills` — root-owned, mode 0555.
  Leaf paths (`outputs/`, `uploads/`, `tool_results/`, `transcripts/`,
  `<skill-id>/`) are intentionally NOT pre-created. When a bind is
  attached the docker daemon creates the leaf as the bind target;
  when not attached, the leaf does not exist — the model gets ENOENT
  instead of an empty writable dir that looks "mounted but uploaded
  nothing".

  `pnpm sandbox:smoke` (alias for `pnpm --filter @namzu/sandbox
test:smoke`) runs an opt-in docker integration test exercising the
  leaf-permission contract against a real docker daemon. Excluded
  from the default `pnpm test`; gated by a dedicated
  `.github/workflows/sandbox-smoke.yml` workflow that builds the
  reference image and runs the smoke test on PR / push when the
  sandbox surface changes. On CI (`process.env.CI === 'true'`), the
  smoke test fails fast if docker / the image are absent rather than
  silently skipping.

  `@namzu/sdk` exports `ContainerSandboxLayout`,
  `ContainerSandboxLayoutMount`, `ContainerSandboxMountSource`,
  `ContainerSandboxSkillMount`, `ResolvedContainerSandboxLayout`,
  and the five `SANDBOX_DEFAULT_*_PATH` constants from its root
  barrel. `@namzu/sandbox` re-exports those names plus
  `ContainerSandboxLayoutValidationError`, `serializeSandboxError`,
  and the `SerializedSandboxError` shape. The packed-tarball shape
  is verified by `.github/scripts/verify-consumer-install.sh`'s
  `@namzu/sandbox public-surface fixture`, which installs the
  package from a tarball into a clean project and asserts every
  documented constant + runtime export comes back via both
  `@namzu/sandbox` and `@namzu/sdk` import paths. `@namzu/sandbox`
  is also added to `ci.yml`'s `publint` and ATTW (Are The Types
  Wrong) gates.

### Minor Changes

- 04551a8: feat(sandbox): `container:docker` backend implementation

  P3.1 — first concrete backend lands. `createSandboxProvider({ backend: { tier: 'container', runtime: 'docker', image } })` now returns a working `SandboxProvider`:

  - Spawns one Docker container per `Sandbox` instance via the `docker` CLI (no node-docker SDK dep — keeps the package thin).
  - Container runs the small HTTP worker shipped under `packages/sandbox/worker/server.js`. The host adapter talks to it on `127.0.0.1:<random-port>`.
  - Worker exposes `/healthz` (liveness), `/execute` (NDJSON-streamed command run), `/read-file`, `/write-file`. All `Sandbox` interface methods route through these.
  - Container goes away on `Sandbox.destroy()` (`docker rm -f`).
  - Workspace bind-mount under `/tmp/namzu-sandbox-<id>-*` cleaned up on destroy.
  - Resource caps from `SandboxBackendOptions` map to Docker flags: `memoryLimitMb` → `--memory`, `maxProcesses` → `--pids-limit`. Default network is `none` (egress proxy plumbing is P3.2).

  Reference Dockerfile (`packages/sandbox/worker/Dockerfile`) ships with a comprehensive pre-installed toolchain so a greenfield namzu deployment "just works" against the typical agent workload:

  - **Office IO**: openpyxl, xlsxwriter, python-docx, python-pptx, pypdf, reportlab, pdfplumber, pymupdf, pdf2image, docx2pdf.
  - **Rendering**: weasyprint, pydyf, markdown, jinja2, beautifulsoup4, lxml, html5lib.
  - **Data**: pandas, polars, numpy, pyarrow, duckdb, sqlalchemy.
  - **Charting**: matplotlib, plotly, seaborn, kaleido.
  - **ML / stats**: scikit-learn, statsmodels, scipy.
  - **OCR / image**: pytesseract, Pillow, opencv-python-headless.
  - **OR / planning**: ortools, pulp, simpy, networkx, workalendar.
  - **HTTP**: requests, httpx, aiohttp.
  - **System tools**: LibreOffice, pandoc, Ghostscript, qpdf, poppler-utils, tesseract (eng+tur), ImageMagick, exiftool, optipng, jpegoptim, graphviz, Chromium (+ chromium-driver), ripgrep, jq, yq, tree, htop.
  - **Node toolchain**: `@mermaid-js/mermaid-cli`, xlsx, docx, pptxgenjs, pdf-lib, sharp, markdown-it, dompurify, jsdom.
  - **Fonts**: Noto (Latin + CJK + emoji + symbol), Liberation, DejaVu, FreeFont — Turkish-friendly.
  - **Distro**: Debian Bookworm slim, not Alpine — manylinux wheel coverage matters for the doc-gen path; compass-platform hit musl issues on the same workload.

  Hosts that want a leaner image build their own and reference it via `ContainerBackendConfig.image`. The fat default exists so the agent isn't told to use a tool that doesn't exist (the prompt-vs-runtime drift class of bugs Codex flagged repeatedly in the Vandal Cowork iterations).

  Trust model: container is the trust boundary; worker listens on loopback inside its own netns; outbound network defaults to `none` until the egress proxy lands in P3.2. Worker runs as non-root (`namzu:1001`) inside the container; host mounts `/workspace` writable to that uid.

- 663f504: feat(sandbox): new package — pluggable SandboxProvider for @namzu/sdk

  Introduces a new workspace package `@namzu/sandbox` that wraps the
  `SandboxProvider` shape `@namzu/sdk` already declares with concrete
  backends. Sandbox is intentionally split off the core SDK because:

  - Native dependencies (`bubblewrap` binary, seccomp filter generation,
    Docker SDK, parent-proxy machinery) shouldn't pollute every namzu
    consumer.
  - Anthropic itself ships their sandbox runtime as a separate package
    (`@anthropic-ai/sandbox-runtime`) for the same reason.
  - Hosts that don't need isolation (tests, trusted environments) can
    skip installing it.

  This commit is the **public-surface skeleton** — the package is
  declared, the contract is fixed, but no backend is implemented yet.
  Calling `createSandboxProvider({ backend })` throws
  `SandboxBackendNotImplementedError` for every backend tag. Backends
  arrive in subsequent commits per the
  `ses_004-native-agentic-runtime-and-sandbox` design session:

  - **P3.1** — `process` backend (Anthropic sandbox-runtime adapter).
  - **P3.2** — `EgressPolicy` plumbing with the proxy daemon.
  - **P3.3** — `container` backend (compass-platform pattern).

  The exported surface freezes:

  - `SandboxBackendKind = 'process' | 'container' | 'passthrough'`
  - `EgressPolicy` (deny-all / allow-all / static / resolver)
  - `SandboxBackend` and `SandboxBackendOptions`
  - `SandboxProviderConfig` and `createSandboxProvider`
  - `SandboxBackendNotImplementedError`

- 274bcfa: feat(sandbox)!: tiered backend taxonomy aligned with 2026 industrial standard

  Restructures the public surface from a flat backend-tag list into a
  four-tier taxonomy that mirrors how production agent platforms
  actually deploy code-execution sandboxes:

  - `process` — Claude Code-style host-process isolation
    (bubblewrap on Linux, Seatbelt on macOS, via Anthropic's
    `@anthropic-ai/sandbox-runtime`). For agents that run on the
    developer's own machine.
  - `container` — OCI container per task. Two runtime options:
    `docker` (default, universal local-dev fallback; what
    Northflank/Railway/Render/Compass-platform/GitHub Actions
    runners ship) and `runsc` (Google gVisor, trusted-tenant tier;
    what OpenAI Code Interpreter and Modal Labs ship).
  - `microvm` — Firecracker microVM per task, three concrete
    services: `e2b` (managed, ~150ms cold-start via snapshot
    restore), `fly-machines` (managed, closer to bare-metal), and
    `self-hosted` (`firecracker-containerd` on KVM-enabled Linux for
    hosts that need to own the scheduler).
  - `passthrough` — no isolation; for tests and explicitly trusted
    environments.

  Each tier carries a tier-specific config shape (discriminated union
  on `tier`); picking a tier picks the shape automatically via TS
  narrowing. Industrial precedent for every choice is cited in the
  package README:

  - Adversarial multi-tenant → Firecracker microVMs (AWS Lambda /
    Fargate, Fly Machines, Replit, E2B, Daytona — Fly's
    "Sandboxing and Workload Isolation" post and the original
    Firecracker NSDI '20 paper are the canonical refs).
  - Trusted-tenant → gVisor (GKE Sandbox, Modal, OpenAI Code
    Interpreter — `gvisor.dev/docs/architecture_guide/security` is
    the reference).
  - Single-user developer machine → bubblewrap / Seatbelt
    (Anthropic Claude Code — `anthropic-experimental/sandbox-runtime`).
  - Single-tenant or co-trusted → plain Docker + seccomp default
    profile.

  We deliberately do NOT build our own Firecracker scheduler — that
  is E2B's and Fly's entire product, and writing our own would be a
  years-long detour. The `microvm` tier adapts to theirs and
  reserves `self-hosted` for compliance/air-gap deployments.

  `EgressPolicy.resolver` is now parameterless
  (`() => Promise<string[]>`). Per Codex's stop-time review, the
  prior shape took a `EgressResolveContext` with `tenantId` /
  `runId` / `agentId` fields the SDK runtime had no way to populate,
  so the resolver context was permanently unreachable. Hosts that
  need per-tenant policies bake the tenant into the closure that
  constructs the provider — exactly how compass-platform's
  JWT-minting flow already works.

  Same reason for dropping `tenantId` / `runId` / `agentId` from
  `SandboxBackendOptions`: a contract the runtime can't fulfill is
  worse than not having it.

  **Breaking** for consumers of the still-pre-1.0 surface introduced
  in the previous skeleton commit (no implementations existed yet,
  so realistic migration cost is zero).

  Phase plan unchanged in structure but renumbered for clarity:
  P3.1 ships `container:docker` first (works locally and in any
  cloud), P3.2 the egress proxy, P3.3 the `microvm` managed adapters,
  P3.4 the `process` tier, P3.5 the adversarial-multi-tenant tier.

### Patch Changes

- 8022011: fix(sandbox): docker backend lifecycle leak + worker symlink escape

  Two issues Codex stop-time review caught on the just-shipped
  `container:docker` backend (#32):

  **HIGH — container lifecycle leak.** `spawnDockerSandbox`'s create
  path had no rollback on failure. If `docker run` succeeded but
  `/healthz` polling timed out (slow image, kernel under pressure,
  network-namespace setup hiccup), the temp workspace under `/tmp/`
  plus the running container were both orphaned. The
  `reservePort()` pattern also had a TOCTOU race: this process
  allocated a host port, closed the listening socket, then passed
  the number to `docker run --publish 127.0.0.1:PORT:…`, leaving a
  window where another process could bind the same port.

  Fixed:

  - `spawnDockerSandbox` now wraps create in `try/catch`. The catch
    arm runs `cleanupOnFailure()` which `docker rm -f`s the
    container if it started and removes `hostWorkspace` if it was
    created. Both are tracked via a flag/var captured in the outer
    scope.
  - Switched from pre-reserve-then-publish to letting Docker
    allocate via `--publish 127.0.0.1::WORKER_PORT`. The mapped
    host port is read back via `docker inspect --format
'{{(index ...).HostPort}}'`. No TOCTOU window.

  **MEDIUM — symlink escape in worker.** `resolveWithinWorkspace()`
  in the worker's `/read-file` and `/write-file` handlers checked
  the lexical path string but `fs.readFile` / `fs.writeFile`
  follow symlinks. A symlink inside `/workspace` pointing to
  `/etc/passwd` (or anywhere outside the bind-mount) bypassed the
  boundary.

  Fixed: added `realpathWithinWorkspace()` which `realpath`s both
  the workspace root and the requested target, then verifies the
  resolved real path is still inside the workspace. For writes
  where the target may not exist yet, the parent directory's
  realpath is checked instead. Both handlers now resolve through
  the new helper before touching the file.

- 63e44f7: Worker `handleExecute` no longer crashes the per-task container when a
  single request body is rejected by `resolveWithinWorkspace` (e.g. a host
  path forwarded as `cwd`) or by the workspace `mkdir`. Each fallible step
  now returns a typed `400` (or a terminal NDJSON `error` event for
  post-headers failures) and the worker stays alive for the next call —
  prior behaviour was an unhandled rejection on the `http.createServer`
  callback, which on Node ≥ 15 exits the process and gives every
  subsequent SDK call the bare `fetch failed` from `UND_ERR_SOCKET`.

  The docker backend's host-side `execViaWorker` and `writeFile` fetches
  now surface `error.cause.code` / `cause.message` instead of the
  stripped `fetch failed`. The bash builtin no longer forwards
  `context.workingDirectory` (a host-side path that has no meaning
  inside the sandbox container) as `cwd`; tools that need a sub-cwd
  inside the sandbox can be added later via an explicit
  `SandboxExecOptions` field.

  The SDK's iteration aggregator now derives
  `ChatCompletionResponse.toolCalls[i].function.arguments` from each
  bucket's parsed input rather than the raw `argsBuf` buffer. When a
  provider stream truncates with `stop_reason: "max_tokens"` mid-
  `input_json_delta`, downstream `JSON.parse` in
  `runtime/query/executor.ts:executeSingle` no longer rejects with the
  generic "Invalid JSON in tool arguments" — the tool runs against the
  empty parsed object and the input zod schema produces a readable
  "<field> is required" error instead.

- Updated dependencies [542f057]
- Updated dependencies [df09910]
- Updated dependencies [140bcc0]
- Updated dependencies [ea21863]
- Updated dependencies [38c4b62]
- Updated dependencies [265150b]
- Updated dependencies [a1c6694]
- Updated dependencies [52af97e]
- Updated dependencies [a71422a]
- Updated dependencies [d6b5bc1]
- Updated dependencies [8fd9349]
- Updated dependencies [63e44f7]
- Updated dependencies [63b4885]
- Updated dependencies [38c4b62]
- Updated dependencies [6b74cd0]
- Updated dependencies [d86b161]
  - @namzu/sdk@1.0.0
