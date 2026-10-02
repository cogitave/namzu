# Native Windows Pal activity subscription proof — 2026-10-02

The native Windows Node process exited **0 after confirmed cleanup** of both owned Pal runtimes and their real local computers. The caller used a WSL UNC working directory. This exercised the built production SDK, CLI, durable stores, current permission checks, query recorder, guest tools and Podman provider. Model inference and private catalogue discovery used scripted fixtures.

- [Sanitized receipt](artifacts/pal-native-subscriptions-20261002.json)
- [Executed harness](windows-pal-subscription-proof.mjs)
- [Independent audit of the unchanged runtime snapshot](artifacts/pal-native-review-20261002.json)

## Executed evidence

| Check | Result |
| --- | --- |
| Runtime | Actual Windows Node v22.20.0; UNC caller directory |
| Source | Actual SDK query, original journal and request envelope; real guest write and PNG |
| Publication | Nine fresh native processes; bounded pages, restart progress and exact dedup |
| Delivery | 14 accepted observations; all 14 recorded, zero pending or claimed |
| Provider admission | 105 exact original-log receipt checks before scripted provider delegation |
| Source preservation | Original 36-record journal SHA256 unchanged; cursor reached 36 |
| Wake revocation | Dispatch refused with zero provider requests; pending input retained |
| Observe revocation | Fresh publication refused without changing progress, source journal or profile |
| Recipient | Separate actual local computer; guest file write/read, Linux shell output and PNG |
| Shutdown | Native parent exit 0 after outer cleanup; both owned guests released |

The source and recipient used separate newly created fixture Pals and private state. No existing user Pal, session, account or external message recipient was used. Observation bodies contained only the closed allowlisted metadata facts. Source prompt text, model answers and private guest-file content were absent from accepted envelopes and recipient history.

## Authority and limits

The trusted local operator fixture explicitly granted directed observe, disclose, receive and wake permissions. Each relevant phase read current consent. A saved grant describes accepted authority and does not replace current permission checks. Exact original journal scope, pinned Pal revision, bounded request-marker evidence and recorded ingress receipts supplied causality. Delivered observations remained `host-observation` runtime context; they did not become operator steering or review approval.

This activity proof does not exercise an external channel actor, account, authenticated remote transport or remote response outbox. It proves finite local publication and dispatch, rather than a continuously running listener or remote exactly-once delivery. The local computer is a Podman Linux container guest, not a full VM. The existing local machine and prebuilt image were reused; no dependency installation, registry consumer install or credentialed model inference was tested.

## Code identity

The receipt records the executed harness SHA256, six critical production module hashes, consumer manifest hash, and the complete SDK/CLI/sandbox dist-tree hashes from the independently audited unchanged snapshot. The harness bytes exactly matched this research source. The same snapshot was used for the native parked-review proof, whose canonical receipt records those runtime tree hashes.

The base Git commit/tree identify the committed foundation only. The tested consumer snapshot also includes the current uncommitted implementation; the runtime file/tree hashes identify that executed code. Private home and working-directory text, and all Pal/session/subscription IDs, are omitted from the public receipt.

## Fixture corrections

An initial bootstrap attempt did not forward the explicit engine variables into native Node; the harness invocation was corrected to use `WSLENV`. A later fixture assertion incorrectly treated the recipient's own generic guest home path as source-private content. Its privacy checks were narrowed to the source's private control path and synthetic source markers. A clean rerun then passed. These corrections changed the proof invocation/assertions, with no production-code change.
