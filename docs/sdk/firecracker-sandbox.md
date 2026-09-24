---
type: Guide
title: Firecracker sandboxes
description: The Firecracker microvm tier against a self-hosted orchestrator — the provider config that reaches it, the reserve-before-admission exec path over the framed guest-agent wire, the opt-in per-phase exec timing hook that attributes a call's wall clock to a named phase, the loopback numbers the suite measures, what the breakdown deliberately cannot attribute, and the half-close contract a host-owned relay in front of the guest has to honour.
resource: packages/sandbox/src/backends/firecracker/transport.ts
tags: [sdk, sandbox, firecracker, microvm, timing]
status: draft
generated: { by: process:claude-code, at: 2026-09-18T00:00:00Z }
---

# Firecracker sandboxes

`@namzu/sandbox`'s `microvm` tier, against a self-hosted orchestrator the host
runs: its control plane mints a guest per task and resumes it copy-on-write
from a golden snapshot, so a cold start is a resume rather than a boot. The
guest runs the same `agent/agent.cjs` the [Kubernetes tier](kubernetes-sandbox.md)
bakes into its pod image, and speaks the same framed NDJSON protocol over it;
the transport underneath is what differs, and it is the only part of the exec
path this page is about.

## Configure a provider

```ts
import { createSandboxProvider } from '@namzu/sandbox'

const provider = createSandboxProvider({
  backend: {
    tier: 'microvm',
    service: 'self-hosted',
    orchestratorEndpoint: 'https://sandbox.example',
    getToken: async () => process.env.SANDBOX_TOKEN ?? '',
    template: 'golden-2026-09',
  },
})
```

`orchestratorEndpoint` and `getToken` are both required, and both exist to keep
this package free of a cloud SDK: the host runtime owns how the bearer is
obtained, exactly as `KubernetesBackendConfig.access` and ACI's `getArmToken`
do. `template` selects the golden revision to resume; `agentSnapshot` resumes a
per-agent capture layered on it. `mtls` is the NETWORK-mode client material —
when the orchestrator answers with an `mtls` agent handle, those bytes are
merged onto it and the transport dials the per-host relay over mTLS;
`controlPlaneMtls` secures the create/destroy calls themselves when
`orchestratorEndpoint` is reached over the public internet.

## The exec path

`Sandbox.exec` reaches the guest through, in order:

1. **Reserve.** A fresh connection, one framed `reserve-execution` request, one
   framed reply. The shared `RemoteExecutionController` bounds this round trip
   at two seconds and requires a protocol-version-2 reply carrying an
   `exec_…` id; a guest that does not implement the op is refused by name
   before any command is admitted.
2. **Execute.** A second fresh connection — this transport caches no socket and
   no address, so a resumed guest's new endpoint costs nothing extra, and a
   connection severed by a resume cannot be mistaken for a live one. The
   framed `execute` request goes out; the guest streams NDJSON events
   (`stdout_delta`, `stderr_delta`, then the terminal result) and ends the
   stream with a **zero-length terminator frame**.
3. **Close.** The guest calls `socket.end()` after the terminator, and this
   transport resolves the call on the peer's `close` — not on the terminator.
   Until that close arrives the call is over the wire but not over.

Every dial runs under a connect-retry budget (30 s by default) because the
common connect failure is transient: an agent re-listening after a resume
answers `ECONNREFUSED` for a moment, and the host re-dials rather than
reporting a dead sandbox.

## Per-phase timing

`MicroVMBackendConfig.onExecTiming` is the opt-in hook that says where an
exec's wall clock went. It fires once per `exec()`, on the failure paths as
well as the happy one, with a `FirecrackerTransportTiming`:

```ts
import { createSandboxProvider, type FirecrackerTransportTiming } from '@namzu/sandbox'

const provider = createSandboxProvider({
  backend: {
    tier: 'microvm',
    service: 'self-hosted',
    orchestratorEndpoint: 'https://sandbox.example',
    getToken: async () => process.env.SANDBOX_TOKEN ?? '',
    onExecTiming: (timing: FirecrackerTransportTiming) => {
      console.log(
        `dial=${timing.dialMs} reserve=${timing.reserveMs} execute=${timing.executeMs} ` +
          `drain=${timing.drainMs} first=${timing.firstFrameMs} ` +
          `term=${timing.terminatorMs} close=${timing.peerCloseMs}`,
      )
    },
  },
})
```

The four base phases — `dialMs`, `reserveMs`, `executeMs`, `drainMs` — carry
the same names and the same meanings they carry on the Kubernetes tier, whose
`onTiming` reports them for a transport built on this one. (The two hooks are
not interchangeable: a Kubernetes transport inherits `onExecTiming` from the
shared options and never fires it, because it drives that shared transport
through `executeStreamed` rather than through `exec()`. Set `onTiming` there.)
`firstFrameMs`, `terminatorMs` and `peerCloseMs` are this tier's own, because
only this tier owns the socket that carries the execute round trip; they are
intervals inside `executeMs`, all measured from the moment the request was
written. A phase that was never reached is **absent** rather than zero: a call
that failed at the dial reports four numbers, not seven, and a dial that never
connected contributes nothing to `dialMs` either — `onDialAttempt` paired with
`onDial` is what says a connection was never made.

Three things the breakdown is careful about, all of them stated on the type:

- **It is not an accounting identity.** `reserveMs` and `executeMs` each
  include their own dial, which is also folded into `dialMs`.
- **The guest writes nothing until the command speaks or ends.** For a command
  that prints, `terminatorMs - firstFrameMs` is the time the guest went on for
  after its first frame, which is how a known command runtime is subtracted
  from a call. For a command that prints NOTHING — `sleep 1`, `sh -c ':'` — the
  first frame the host sees is the terminal one, so that difference is near
  zero and both intervals carry the runtime. Read the split against a command
  that talks at its start.
- **It is durations only.** Never the agent token, a command, its arguments,
  or any output, so a host may log it without logging what the sandbox ran. It
  is an observer like every other hook on those options: it cannot change the
  call's result, and a listener that throws is the listener's problem.

Over the loopback suite's unix-socket peer, a `sh -c 'printf out-line'` reports
`dial=2 reserve=3 execute=5 drain=0 first=4 term=4 close=0` milliseconds: the
two dials account for most of the reserve and execute round trips, and the
peer's close lands under the clock's millisecond resolution. Those numbers are
a local loopback measurement from the test suite, not a claim about any
deployment.

## What the breakdown cannot attribute

A host that measures a **near-constant sub-second cost** on every exec and finds
no phase to put it in has learned something this package cannot learn for it:
the time is being spent outside it. The three phases that can absorb such a
cost are all accounted for — `reserveMs` and `executeMs` are round trips this
transport times end to end, and `drainMs` is local bookkeeping that is zero on
a healthy path — so the remaining places a fixed wait can live are the guest
(inside `firstFrameMs`, if it waits before spawning), the network, and a
**relay between the guest and this process**.

The relay is the case worth naming, because it is the one a host owns. After
writing the terminator frame the guest half-closes; this transport resolves the
call on that close. A relay that forwards payload but holds the FIN — its own
idle timer, a full-duplex buffering policy, a proxy waiting for the guest
process to exit — transfers that wait onto every exec, and a hold **under** one
second is reported as `peerCloseMs`, which is the field's whole purpose.

**A hold at or past one second is not a candidate for a cost this size, and the
arithmetic that excludes it is worth following.** The close phase is bounded by
`POST_RESPONSE_CLOSE_TIMEOUT_MS`: a hold of a second or more does not make an
exec slow, it makes it **fail**, with `vsock transport: exec peer did not close
after terminator`. So a deployment whose execs RESOLVE has already proved that
window was under a second, and a fixed cost of ~1 s cannot be hiding in it — an
exec that pays the guard does not return a result to pay it from. And when that
window is reached, no number is reported at all: the field is absent rather
than a `peerCloseMs` of ~1000, because the close that arrives there is the one
this transport causes when the guard fires, and reporting its own constant as
an elapsed time would be the fabrication the field exists to prevent. The
instrumentation therefore supports the same conclusion the issue reached by
reading the code: a resolved exec's ~1 s is spent somewhere this transport does
not time, and the phases it does report are what rule out the places it does.

Two things follow for a host. Instrument both sides of `provider.create()` —
acquire is not an exec. And read the pair, not the number: a `peerCloseMs` near
zero on a resolved call says the relay is not the problem, and a named
`did not close after terminator` rejection says the relay is holding the FIN
past the guard, not that the guest was slow.

## What this tier does not have

- No port rules in an egress profile. `createSandboxProvider({ egressProfile })`
  maps a profile's hosts to the orchestrator's `allowlist` (no hosts to `none`),
  and refuses a rule with `ports` at construction: the orchestrator's network
  policy names hosts and has no field for ports. See
  [Sandbox egress profiles](sandbox-egress-profiles.md).
- No `transport` passthrough. `VsockTransportOptions` has more fields than this
  config exposes (`connectTimeoutMs`, `readIdleTimeoutMs`, `heartbeatMs`, the
  write-size bounds), and none of them is forwarded through
  `createSandboxProvider`. A host that needs one constructs a
  `VsockAgentTransport` directly — the package exports it, and building one
  around its own handle is how the Kubernetes backend is written too.
  `onExecTiming` is on the config because attribution is what a host cannot get
  any other way, and a hook a host has to patch the package to reach is a hook
  no host reaches.
- No timing for the ops that are not exec. `writeFile`, `readFile`, terminals
  and TCP streams dial and stream through the same code, but the hook reports
  `exec()` and `execute()` only.
- No coverage of acquire. A warm-pool acquire is dominated by work that is not
  an exec — the orchestrator's claim for the guest, and the host's own
  workspace seeding — so this hook reports nothing about it. A host attributing
  `provider.create()` needs a clock of its own on either side of the call.
