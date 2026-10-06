# Desktop autonomy work — 7 October 2026

This work continues on the current checkout, beginning at `a32c679ae`.
The target is the Desktop application, including transcript clarity, reading
position, durable work details and visibility of work in another ordinary tab.
Existing Pal friend chat, computer control and user state are separate contracts.

## Primary sources

These are source observations, not a claim of pixel parity or measured model
superiority. Upstream code was read without installing or executing another
application. Similar project names were resolved before using their examples.

| Source and reviewed revision | Useful observation | Namzu decision |
| --- | --- | --- |
| [nightly-labs/openbot](https://github.com/nightly-labs/openbot/tree/8dc668208dc7790d18cf894963ee1a7c199bd2bc), 6 Oct 2026 | Conversation rows have explicit message identity and pure rendering props; large timelines have measured, stable virtualized keys. | Keep settled Markdown parsing behind a text-only memo boundary. Do not add virtualization without measuring a remaining rendering need. |
| [diggerhq/opendots message list](https://github.com/diggerhq/opendots/blob/fbdf673f2648507cf4710ed00d480ba787f4e3a8/src/components/app/conversation/message-list.tsx), 29 Sep 2026 | A bottom-distance threshold and resize observation distinguish following from reading older output. | Preserve reading position, restore it on warm navigation and offer an explicit accessible return to latest. |
| [CopilotKit/OpenDots transcript](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/client/ChatTranscript.tsx), 6 Oct 2026 | Public message identity anchors tool renderers and visible responses. Its parent Chat unconditionally scrolls on messages. | Use real identities and public receipt views; do not copy unconditional scroll behavior. |
| [Google AX concepts](https://github.com/google/ax/blob/ac2332829f22360ff97b0ba34d94dd0dd782f17e/docs/concepts.md), 27 Sep 2026 | Task phase and readiness conditions are separate, with workspace context explicit. | Keep recorded work, display freshness and current runtime/action admission separate. No AX runtime adoption. |
| [Pydantic AI AG-UI](https://pydantic.dev/docs/ai/integrations/ui/ag-ui/), reviewed 7 Oct 2026; repo `099b890407904bf8009997abbaf50d48d23772d0` | UI events retain identity and unsuccessful outcomes. | Restore only source-bound saved receipts and actual terminal outcomes. Do not replace Namzu's native ACP runtime with another protocol. |
| [Google ADK events](https://adk.dev/events/) and [artifacts](https://adk.dev/artifacts/), reviewed 7 Oct 2026; Python `f5b6b0893338f2e1c025cb37792185656719cb1e` / v2.11.0 | Event identity and artifact metadata/version are separate from artifact bytes. | Desktop output actions must come from authoritative deliverable references and physical scope checks, never model-authored paths alone. |
| [Zed parallel agents](https://zed.dev/docs/ai/parallel-agents), reviewed 7 Oct 2026 | Parallel conversations and terminal work remain navigable while another thread is selected. | A main-process observer supplies a fresh count/attention summary to ordinary tabs and Recents. |
| [OpenCode session source](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/app/src/pages/session.tsx), reviewed 7 Oct 2026 | Older-history loading and scroll anchors are explicit. | Keep the current bounded-history disclosure honest; older-page retrieval remains a separate feature. |

[OSWorld v2](https://arxiv.org/abs/2404.07972v2) evaluates real application tasks
against environment state. [Interactive Reward Agent v2](https://arxiv.org/abs/2607.25904v2),
revised 29 July 2026, describes checking post-execution UI and system evidence.
They support checking actual state in addition to screenshots; they do not prove
Namzu's performance or justify marking a model claim as verified output.

## Implemented slices

### Streaming and reading

- Settled assistant Markdown keeps its parsed React subtree when only another
  message changes. Wrapper attributes and inherited theme styling stay live.
- A committed transcript owner owns its observer, listeners and queued frame.
  Streaming follows only when the reader is at the bottom. An explicit jump uses
  smooth scrolling, with immediate movement under reduced motion.
- Warm navigation retains the saved reader position. Wheel movement toward older
  messages interrupts following; a downward wheel at the bottom or a touch with
  no actual scrolling does not silently disable it.
- Attachment snapshots belong to the committed owner and API. Speculative React
  renders cannot retire a still-owned read. Both settlement and send-acknowledgement
  error callbacks are fenced against a different displayed conversation.

### Other-tab background work

One main-process observer reports only running count and attention metadata.
It binds project object, client, displayed session, runtime session and current
harness. It never supplies permission, stop, archive or computer-idle evidence.
Action admission retains its fresh owned registry read.

The observer serializes reads, limits global starts to one per second and each
running session to a two-second minimum interval. Quiet zero results and
terminal failure results stop periodic reads. Confirmations expire after 15
seconds; main publishes unknown and a renderer also rejects already expired
snapshots. An in-flight read is retained across expiry while its old visible
confirmation is retired. Owned open, action and tool-settlement hints can seed
another observation. Closed panels no longer poll job output lists independently.

Ordinary tabs and Recents show compact running/attention indicators. Pal chat
and externally owned Codex/Claude process lifetimes are not assigned Namzu's
shell-registry badge. The metadata event does not revise the transcript.

### Saved work details

Ordinary history uses one strict owned conversation snapshot. Its selected folded
messages remain authoritative, with the existing 200-message / 200,000-character
aggregate / 32,000-character per-message bounds. A versioned, optional work
projection carries only retained message/turn/order anchors, bounded recorded
public tool views and actual terminal classifications.

A reopened half-finished action is Interrupted, not Running or waiting for a
historical approval. Reused call IDs are scoped by actual turn and latest attempt.
Skipped actions remain distinct from success. Runtime duration is separate from
Desktop admission timestamps. Missing legacy presentation is explicitly absent;
raw tool inputs, structured spill bodies, opaque reasoning and signatures are not
re-presented or hydrated. The projection restores no permission or retry authority.

## Verification

The [browser receipt](artifacts/desktop-reading-browser-proof.json) and its
[reproducible script](desktop-reading-browser-proof.mjs) use the actual Vite/React
renderer with isolated events, zero model requests and zero computer actions.
They exercise 60 distinct historical turns / 120 messages, streaming while
reading, keyboard return to latest, warm navigation, other-tab work states,
the actual rich-history helper (exact diff, skipped/failed/interrupted receipts,
saved runtime duration and separate detail completeness),
narrow/short light view, reduced motion and Pal bubbles with hidden scrollbar.
V8 precise coverage records eight `createProcessor` calls for four changed live
bodies in development StrictMode: two calls per changed body, no settled parses.

The retained v1 browser receipt used one synthetic timeline turn and therefore
was not representative of normal history grouping. The corrected fixture uses
60 distinct turns. The first development coverage assertion expected four calls
and failed because of StrictMode double invocation; the correction is explicit,
not a production single-render claim. The first failed stdout was observed in the
tool log; it was not retained as a separate JSON before that initial proof rerun.

Three retained rich-fixture failures identify overly broad Playwright selectors
and an incorrect expected label for an interrupted turn. The corrected proof
checks the actual existing Work incomplete label and exact tool-state elements;
these selector corrections do not change the renderer.

Integrated workspace typecheck and lint passed; lint retains 35 SDK and 12 CLI
warnings. The first complete workspace run stopped on one existing Sandbox local shell/Git
clone regression at the default five-second Vitest limit (6.679 seconds). Its
51-test file passed independently; the operation/assertions stay unchanged with
a documented per-test 30-second Vitest timeout. The final full run is pending;
the first failure is retained and is not relabelled as a pass.
CLI and Desktop builds passed. Native prepare passed against the current owned
Windows window, checking idle conversations and the installed package graph;
it is a preflight, not evidence that new bytes have been activated. Existing
6 October real engine tests are prior evidence, not new provider calls in this work.

## Remaining architectural opportunities

- Namzu already has `DeliverableRef` with file/hash/size, message, summary and
  artifact-blob references. Desktop Pal Outputs currently projects diff receipts
  only. General artifact actions need producer agreement and physical file
  ownership/verification, not filename extraction from prose.
- Full final ACP views are not all durably stored today. A future optional SDK
  presenter seam must select, whitelist and bound the post-screen/post-hook view
  once before append. Reopening must never execute a current presenter over an
  old raw tool input. This first slice uses the existing recorded presentations.
- Live prompt projection can retain attachment preview base64 after successful
  consumption, beyond the active 24 MiB attachment quota. Bound a display-preview
  cache separately from admitted model bytes and SDK replay before changing it.
- Full conversation search needs a scope-admitted human/assistant index. The
  existing evidence FTS index is not a full user-message search contract.
