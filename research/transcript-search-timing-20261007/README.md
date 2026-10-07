# Transcript search and timing verification

The isolated browser checks use the actual Desktop renderer, current ACP mapper,
SDK journal writer and CLI public-history projection. Their conversation content
is a task-owned fixture, without native or provider access. Separate native
verification below inspects the existing conversation and preserves its actual
durable bytes; it does not send a prompt or start a computer.

## Fixture provenance

`create-fixtures.mts` creates an isolated `NAMZU_HOME` and project, writes a
conversation with `DiskSessionLog`, then obtains its public history through
`createDesktopHostExtensions`. The journal assigns real record timestamps.
The browser compares those exact timestamps after navigation and close/reopen;
it does not use the current display clock as historical evidence.

The fixture includes a provider-hosted Web search for RunPod H100 pricing with
9 reported results, two adjacent terminal actions, and two `search_conversation`
lookups whose literal queries are `web_search` and `flexprice`. These two strings
are search inputs, not tool identities or evidence of provider/billing execution.
Pending and completed updates are produced by the current source
`createToolPresenter` and `toAcpSessionUpdate`.
The result count does not create nine invented source links. The two visible
Markdown web links and one sole inline-code URL are explicitly authored in the
synthetic answer. Safe inline-code source URLs remain styled as code and open
through the main bridge. URLs inside fenced code, commands and unsafe schemes
remain inert.

The recorded 4,321 ms settlement duration is controlled fixture data, not a
measured provider job. A separate legacy text-history fixture has no timestamps;
the renderer must leave its clocks absent.
The two conversation lookups have controlled 321 ms and 654 ms durations;
their exact receipts and timings remain available in explicit details.

## UI scope

`renderer-proof.mjs` checks the actual renderer at 1280×900 dark, 640×720 light
with reduced motion, and 560×640 dark with reduced motion. The last size matches
the native app's 560 px minimum window width (`main/index.ts`). It exercises work
disclosures with pointer and keyboard input, flat action rows, web-link routing
through the mocked main bridge, hostile-link rejection, cold-history clocks,
and live host-observation clocks through terminal settlement.

The expanded work rail presents human phrases (`Searched the web`,
`Checked earlier messages`) and keeps routine completion labels and clocks
visually quiet. The two adjacent conversation lookups share one human summary;
their individual inputs and recorded results remain reachable through explicit
details. Ordinary terminal actions stay separate, without an `Actions completed`
nest. Keyboard focus reveals exact known timestamps and subsecond durations;
a standalone message clock can show the full local date. An authoritative settled
turn reads `Worked`, with no stale `Thinking` label. No source links or timing
measurements are invented from an action caption.

WAI comparison criteria come from the
[captured seeded reference](../local-speech-20261007/artifacts/wai-reference.json):
32 px disclosure/action rows, 14/20 px header text, 8 px header gap, and a rail
with 16 px content inset. This is a comparison of the inspected layout and
interaction states, not a claim of pixel parity or agent-runtime equivalence.
Namzu retains its own theme and branding.

An extra 390 px browser stress run passed the interaction, timestamp and search
checks, but the workspace's explicit 380 px minimum pane plus 48 px navigation
rail exceeded that unsupported viewport. Its failed bounds receipt is preserved
in `artifacts/small-viewport-before.json` and `transcript-small-dark.png`. This is
not reported as responsive fit. The first 21 px versus 20 px header line-height
difference is preserved in `artifacts/geometry-before.json`; the root corrected
that measured difference before the final matrix.

At the supported 560 px minimum, the first hosted-search row exceeded its parent
by 34.75 px because a grid child retained its automatic minimum width. That
pre-fix geometry is preserved in `artifacts/tool-row-before.json`. The root set
the action grid child to `min-width: 0`; final verification checks each action
row and its status/clock children against the parent's actual bounds.

## Inspected references

- [BeautifulUI](https://www.beautifului.dev/) was inspected in a fresh browser
  context at 1280×900. Ten captured states cover compact thinking/search rows,
  quiet tool chips, task rows and answer sources. Real DOM/style observations and
  screenshots are in `reference-beautifului/`. These are public demo states;
  no agent execution is established by them.
- Official Vercel AI Elements pages for
  [Reasoning](https://elements.ai-sdk.dev/components/reasoning),
  [Chain of Thought](https://elements.ai-sdk.dev/components/chain-of-thought),
  [Sources](https://elements.ai-sdk.dev/components/sources), and
  [Tool](https://elements.ai-sdk.dev/components/tool) were inspected alongside
  shadcn primitives. `reference-ai-elements/receipt.json` records real DOM,
  controls and state changes; four retrieved source files are pinned to
  revision `6a9d5b1822ffb10bba4bd97175f01edd7d8651cd`, with immutable URLs and
  hashes recorded. Their raw copies stay in a task cache outside the repository;
  see the [source provenance](reference-ai-elements/findings.md). The public pages reported
  hydration errors, which remain recorded rather than being hidden.

These references inform a compact primary summary, explicit expandable
evidence, truthful live versus completed labels, and accessible controls.
Namzu keeps 32 px row targets; it does not claim identical pixels or adopt
technical debug cards as the ordinary conversation summary. Current browser
proof records 32 px primary row intervals, collapsed and expanded panel heights,
and unchanged chevron hit targets before hover, during row hover, and while
hovering its revealed timestamp.

## Native application verification

The approved Windows application was updated through the guarded helper
`native-search-speech-activation.cjs`, with the old Desktop payload retained as a
backup. The first activation also updates one CLI history module and one SDK ACP
mapping module. The later `--desktop-only` refresh replaces main/preload/renderer
while reviewing the same runtime modules without changing them. Both verify the
unchanged launch/dependency graph, exact durable journal bytes, profiles,
computers, projects, tab order, selected conversation, authored messages, drafts,
models, attachments and task state. The final refresh preserves voice preference
and installed runtime metadata too. All work and voice must be idle before close;
the physically stopped Podman machine remains stopped.

The [sanitized preservation receipt](artifacts/native-activation-preservation.json)
contains aggregate checks and SHA-256 digests only. Private snapshots remain in
the native Development directory. The initial guards retained their refusals:
an empty conversation legitimately has no journal, and a settled live cache may
hold host-observed time before a durable message identity is restored. The revised
preflight allows those exact cases; after restart it still requires every known
cold clock to match its unchanged journal identity and time.

The [native transcript receipt](artifacts/native-final-transcript-proof.json)
records the final open Windows application: nine journal-based message clocks,
eight ordinary Markdown HTTPS source links, a human `Searched the web` summary,
quiet completion/time, and no repeated `Actions completed` header. The actual
[search row](artifacts/native-final-web-search-step.png) contains no private
message body. Work bodies were opened for inspection and their previous disclosure
states restored. The probe's earlier inline-code assumption was incorrect: these
native sources are Markdown links. Sole inline-code sources are covered separately
by the actual renderer fixture. No unsolicited native external-browser launch,
provider prompt or computer action is performed by this proof.

After the human-summary product change, all 882 Desktop tests, full workspace
typecheck/lint, Desktop build, the three browser matrices, documentation and
doc-fence checks pass. The repeated full workspace test run passes 20,142 tests
with 116 declared skips. Full workspace build also passed earlier in this change.
No push or release is part of this local update.

## Reproduce

```sh
node --import tsx research/transcript-search-timing-20261007/create-fixtures.mts .
node research/transcript-search-timing-20261007/renderer-proof.mjs .
```

The browser uses a separate loopback Vite server with reload disabled, only
synthetic API responses, and blocks requests outside that server. It creates
no native application or model session.

Results are recorded in `artifacts/journal-fixtures.json` and
`artifacts/renderer-proof.json`; matching renderer screenshots are listed in
the latter receipt.
