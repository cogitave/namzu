# Composer interaction and delivery audit

## Scope and sources

The operator reported Quick search breaking and asked for the actual model,
settings and attachment interactions shown in the reference composers. The
work continues from `3ff96b40` in the owned `feat/runtime-desktop-foundation`
worktree. The primary reference remains the MIT-licensed source clone
`/tmp/namzu-workflow-peers-20260930.ckQyBT/t3code`, revision
`c18e5ea6ed741443a8ec4a5d22d4b6939b0ecd21`.

- `apps/web/src/components/chat/TraitsPicker.tsx:234` derives visible controls
  from model descriptors rather than presenting universal effort/thinking modes.
- `chat/ChatComposer.tsx:1606` captures an attachment draft target separately
  from later asynchronous upload work; attachment records and previews follow
  that owner. `ChatView.tsx` snapshots draft attachments into message/queue
  admission rather than rebuilding them from mutable file paths.
- The appUI popup and its icon family were already examined in
  [the preceding audit](MODEL-PICKER-20261001.md). The extra paperclip, text-file,
  puzzle glyphs use unchanged SVG paths from the same licensed original source;
  ellipsis and rounded navigation outlines use the existing stock icon package.
  `icon-source-map.json` identifies both sources.
- The supplied images establish visible composition, not reference DOM, fonts,
  timing or unsupported product capabilities. No voice, branch or worktree
  action is presented without an implemented host operation.

## Verified corrections

The exact reported Quick search break was not reproduced against the clean
baseline build on Linux Electron: four providers, 185 long catalogue names,
click and `/`, empty/error/delayed results, 560×460 and 117 intermediate frames
kept one panel/input, focus and geometry stable. This does not establish native
Windows hit testing. Source panel repetition is not evidence of duplicate
visible panels. Confirmed baseline gaps were missing search Enter/arrow
selection, raw transport diagnostics, a misleading empty state on failure,
and no per-provider retry.

The updated picker has one active panel, keyboard search selection, explicit
selection dismissal/focus return, safe failure copy, provider retries and
visible fallback notices in global search. Provider browsing does not select a
route; model selection still applies on the next actual Send.

Native file picks capture regular bounded files in main. Drop/paste admission
receives bytes rather than renderer paths or MIME claims. Main validates image
signatures/UTF-8, retains exact bytes and exposes only bounded file metadata and
safe previews. Draft, first-message promotion, queue edit/remove, cancellation
and provider errors preserve the appropriate owner. Later source-file edits
cannot change an admitted message. Text becomes labelled authored prompt
content; images enter the existing SDK attachment path. Unsupported native
binary/PDF inputs are visibly refused.

ACP adds opt-in inline prompt attachments and reasoning/review options with
advertised capabilities. An older CLI cannot silently consume an unsupported
draft. Reasoning uses the actual provider/fallback menu; permissions use the
existing five modes. Main retains unsent model/settings choices across renderer
reload. Installed plugin inventory does not import modules or create a runtime;
loaded plugin changes are idle-only, session-local and replayed on model change.
Raw plugin initialization/settings diagnostics remain internal.

Adversarial checks also found attachment/settings-only conversations omitted
after reconnect, stale attachment reads begun during an open chooser, and an
absent saved model becoming an invalid empty persisted choice. Retention,
mutation-completion fences and registry default normalization correct those
boundaries. `attachment-hook-probe.mjs` imports the actual source hook and uses
deferred IPC promises; its receipt records the before observation separately
from current assertions.

## Acceptance and evidence

- [x] Quick search click, typing, Arrow Down/Space, Enter, Escape/focus return.
- [x] Safe catalogue error and fallback-notice retries through real host methods.
- [x] Native chooser, preview/removal, drop/paste and renderer-reload ownership.
- [x] File-only Send reaches the actual CLI/kernel with exact PNG SHA-256 and
  captured text, even after changing the original file.
- [x] Queued files/settings survive editing after the current controls change.
- [x] Actual Plan rejects a write; Allow tools performs that same write.
- [x] Wide and narrow/reduced-motion bounds stay inside the viewport.
- [x] Cancelled/provider-failed file retry and final frozen native receipts.
- [x] Package and documentation checks.
- [x] Windows preview refresh and actual pointer opening of Quick search.

`composer-interactions.mjs` runs real Electron, CLI, kernel and filesystem/tool
operations in isolated storage. Only model/network I/O is scripted. The initial
run passed with eight actual agent requests. The expanded cancellation retry
initially failed because the fixture repeated a signed tool-call ID across two
turns. The real kernel correctly refused this invalid history before starting
another turn. Unique fixture IDs fixed the probe; no history validation was
relaxed. The final frozen composer run passed with twelve actual agent requests,
including cancellation and synchronous provider failure with exact-byte retries.
The failure admission reply was held until actual settlement, so the recovery
assertion does not race a real timer. Seven screenshot/geometry pairs show
settled states at 1180×820 and 600×540, with reduced motion at the narrow size.

The updated continuity probe passed with six actual agent requests and a real
foreground/background shell. It keeps original deferred-history/provider/job
isolation checks, drafts/reload/offline refusal and reconnect. Its second
conversation is explicitly seeded through the native API for the navigation
baseline; the landing itself creates no hidden session.

The subsequent light-sidebar image is a new visual reference. It is not present
in the current appUI source consumers; its exact icon family remains unverified.
Verified shape corrections use existing licensed assets: rounded outline
navigation glyphs, a plain clock instead of a rewind/history arrow, and a filled
home with the real doorway cutout. Service marks still identify only their
actual providers. This is a visual adaptation, not a claim of literal source
parity. Grouped project conversations and opened-conversation tabs are a layout
direction to evaluate separately from composer delivery; no decorative navigation
action is added for a host operation that does not exist.

Full workspace typecheck, lint, build and tests passed (SDK 9,649; final CLI 4,732 with
five existing skips; desktop 39). Later gateway/ownership corrections passed
focused tests and CLI/desktop typechecks/builds. Docs conformance and fences,
external-name/log-standard audits and exported-signature checks passed. Existing
CLI lint warnings and bundler directive notices remain warnings. The actual
hook probe additionally verifies newer reloads cannot be replaced by older
admission snapshots with the same mutation revision. A separate real native
probe verifies first Send when preferences name only a provider and no model.

The refreshed native Windows preview is visible and responding at 1196×828,
connected through the owned bridge to the actual built WSL CLI. Exact owned-window
hit testing guarded physical clicks on the model trigger and Quick search. Both
settled popups rendered correctly; no prompt was submitted or model selected.
The capture and process receipt remain in the owned temporary preview directory,
`namzu-desktop-windows-preview-z1zxrmz0`, rather than publishing the operator's
conversation list. The preview was left open. This verifies those Windows
opening states, not the complete Linux interaction suite on Windows.

This is a private source preview. These checks do not claim an installer,
publication, live provider entitlement or the complete repository CI gate set.
