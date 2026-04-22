---
'@namzu/sdk': patch
---

Probe layer (typed observation + narrow veto) over AgentBus + RunEvent stream — ses_007 phases 0–3.

Public surface additions:

- **Typed probe observation.** `probe.on(kind | kind[], handler, opts?)` registers a typed handler scoped to one or more event kinds. `probe.onAny(handler, opts?)` is the catch-all tier preserving legacy `AgentBus.on` semantics. Options: `{ where, priority, name, override }`. Events are frozen at the registry boundary; throws are isolated per probe.
- **Narrow veto on tool execution.** `probe.veto('tool_executing', handler, opts?)` registers a veto handler. Handler returns `'allow' | 'deny' | { action: 'deny', reason }`. `VetoableEventKind = 'tool_executing'` in v1 (additive minor adds more kinds later). First-deny wins by ascending priority; subsequent veto handlers still fire for audit. Tool executor short-circuits before `tools.execute(...)` on deny: returns a synthetic tool failure carrying `ProbeVetoError.message` so the LLM sees a normal tool-call failure with the probe name + reason.
- **5 new bus event variants.** `provider_call_start`, `provider_call_completed`, `provider_call_failed`, `vault_lookup`, `sandbox_decision`. Joined to the existing `AgentBusEvent` discriminated union. Snake_case real discriminants — no rename pass on existing events.
- **Opt-in instrumentation wrappers.** `wrapProviderWithProbes(provider, opts?)` returns an `LLMProvider` that emits `provider_call_*` around every `chat`/`chatStream` call (correlated by a `pcall_${string}` callId, with optional usage telemetry). `wrapVaultWithProbes(vault, opts?)` emits `vault_lookup` on every `retrieve()`; the secret value is never included in the event payload (covered by a "no leakage" test).
- **First-time public exposure of bus event types.** `AgentBusEvent`, `AgentBusEventListener`, `CircuitBreakerSnapshot`, `FileLock`, etc. were already reachable via `AgentBus.on(listener)` at runtime but couldn't be statically typed by consumers. Now in `public-types.ts`. Pre-existing duplicate `LockId` declaration in `types/bus/` was deduplicated to a re-export from `types/ids/` in passing.
- **Replay-aware probe context.** `ProbeContext.isReplay: boolean` flag wired through `buildProbeContext({ runId?, isReplay? })` so probes that bill or call external services can opt out on replayed runs (`ctx.isReplay === true`). Replay-execution wiring lands in a future session; the accessor is ready.

Integration:

- `AgentBus.emit` dispatches through `ProbeRegistry` first (typed-priority probes → legacy `bus.on` listeners → `onAny` catch-all). Existing `bus.on(listener)` consumers see every event in unchanged relative order.
- `EventTranslator.emitEvent` dispatches every `RunEvent` through the same registry before the existing pendingEvents push + persist flow.
- `ToolExecutor.executeSingle` calls `probes.queryVeto({type: 'tool_executing', ...})` immediately after the existing `tool_executing` emit, before `tools.execute(...)`.

Not yet wired (follow-up commits):

- Per-run probes via `createRun({ probes: [...] })` — the registry has the foundation; createRun plumbing lands in a follow-up.
- `wrapProviderWithProbes` / `wrapVaultWithProbes` are opt-in helpers; the SDK's own `ProviderRegistry` does not auto-wrap registered providers yet.
- `sandbox_decision` ships as a type only; emit site lands when a real sandbox provider exists (current `LocalSandboxProvider` is a stub).

Public surface delta: `380 → 392` runtime keys (verified against the regenerated baseline). Net new symbols added by this changeset:

- `probe`, `ProbeRegistry`, `createProbeRegistry`, `buildProbeContext`, `ProbeNameCollisionError`, `ProbeVetoError`
- `wrapProviderWithProbes`, `wrapVaultWithProbes`

Non-runtime (types-only) additions: `ProbeEventKind`, `ProbeEventOf<K>`, `ProbeContext`, `ProbeHandler<K>`, `ProbeOptions<K>`, `Unsubscribe`, `VetoableEventKind`, `VetoDecision`, `VetoHandler<K>`, `VetoOutcome`, `DoctorStatus`, `DoctorCategory`, `DoctorCheck`, `DoctorCheckContext`, `DoctorCheckResult`, `DoctorCheckRecord`, `DoctorReport`, `ProviderCallId`, `ProviderCallUsage`, `SandboxDecisionAction`, plus first-time exposure of all `AgentBusEvent` shape types.

Doctor types ship in this release; the runtime registry + CLI command land in a subsequent ses_007 patch.
