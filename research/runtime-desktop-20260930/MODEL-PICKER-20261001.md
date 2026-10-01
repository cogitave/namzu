# Desktop model selection and navigation refinement

## Reference evidence

The operator requested catalogue selection, filled selected navigation icons,
small interaction animations and a subtle difference between the rail and
sidebar. The supplied screenshot is an image reference; it does not establish
the reference DOM, zoom, font face or motion.

The local appUI working copy at
`/home/arda/workspaces/@cogitave/cogitave-labs/appUI` was inspected in
`components/blocks/composer-panel/model-picker.tsx` and
`styles/composer-panel.css`. Its model popup uses a 341px width, 282px height,
20px corners, 48px provider column, 36px provider controls, 36px model rows and
10px row corners. Its provider glyphs, Quick search and brief hover
transitions informed the Namzu component. This concurrent working copy has no
Git revision or license declaration; no pinned or licensed-copy claim is made.
Namzu uses its installed accessible primitives and CSS, without the reference's
demo models or framework dependencies.

Its icon family was verified against the official source at
`/tmp/namzu-icon-reference-20261001`, tag `v4.9.0`, revision
`019480ec14b97959a1ad35c3de302a224714b068`. The selected original SVG paths match
appUI's cached icon components. A local wrapper renders an unchanged subset for
the shell, composer, menus and result views; there is no new dependency or
installation. Known provider routes use their corresponding service glyphs;
other remote/local routes use stock cloud/server symbols. Normal and selected
navigation states use original line/fill pairs. The exact asset mapping is in
`icon-source-map.json`, and the original license ships with the app's notices.

The pinned MIT source at
`/tmp/namzu-workflow-peers-20260930.ckQyBT/t3code`, revision
`c18e5ea6ed741443a8ec4a5d22d4b6939b0ecd21`, was also inspected:

- `apps/web/src/components/chat/ChatComposer.tsx:6432` describes expanded body
  padding; lines 6949 and 6962 separate model controls from primary actions.
- `ComposerPrimaryActions.tsx:240` and line 252 describe Sending feedback and
  the busy spinner.
- `ComposerPromptEditorTiptap.tsx:750` uses a 78px editor minimum. Namzu retains
  its 40px minimum to preserve the operator's previously requested compact
  expanded editor. These are distinct editor and full-surface measurements.

Existing source notices retain the original license and revision. Product
labels and provider routing remain Namzu's own.

## Data and state ownership

`namzu/providers/models` calls the CLI's real provider listing and the same model
choice/access filter used by the terminal picker. The renderer receives model
IDs, display labels, optional notes and a fallback notice, with no credential
envelope or raw driver diagnostics. Default and current choices are included
only when permitted. A catalogue row is not proof of account entitlement.

The menu loads on demand, searches configured providers and keeps exact model
ID entry available. Browsing a provider does not select it. Radio selection
updates the project/conversation choice; the next Send applies that route before
the actual prompt. Reopening reads a fresh catalogue. Project/conversation
navigation closes the menu, and late results cannot populate another owner's
picker. Catalogue inspection alone creates no session or model request.

The selected Home, Projects or Conversations destination uses its original
filled SVG and neutral rounded surface. The dark rail is `#121212`; the sidebar
is `#171717`. There is no narrow green selection marker. Existing button
pseudo-elements still provide their generic layers and are not selection
markers. Provider/model hover, press, chevron and selected-icon transitions are
brief; reduced motion disables them and loading spinner rotation.
Model radio rows render actual native buttons through the accessible radio
primitive. This corrects a verified Space-selection failure in its non-native
span path without duplicating the selection or keyboard policy.

## Verification

The native harness uses actual Electron, the CLI, the kernel and shell/file
operations with isolated project/trust/application storage. Only model/network
I/O is scripted; catalogue rows travel through the actual provider listing and
desktop wire.

`artifacts/model-picker-native-receipt.json` records the final frozen build:

- real driver rows, an explicitly marked registry default and actual detected
  provider tabs;
- native-button Space selection, Escape focus return, Quick search empty/recovery
  and custom IDs;
- a held old-project catalogue resolving after another project's menu opens,
  without replacing that owner's choice or catalogue;
- provider SVGs with no letter placeholders, neutral selected navigation and
  original filled icon variants;
- disabled, busy Sending feedback during held creation, with reduced-motion
  spinner rotation disabled;
- model controls on the left and actions on the right at 1180×820 and 600×540;
  the main surface measures 106px and 104px respectively;
- an actual 220ms docking animation with the source easing, plus reduced motion;
- exactly three created sessions and three scripted agent requests through the
  existing ownership/admission scenarios.

The five `model-picker-*` screenshot/geometry pairs show catalogue, empty search,
Sending, delayed loading and the new project's narrow/reduced-motion catalogue.
The 341px popup is 284px high with its border at the wide viewport, and 282px at
the constrained viewport, with no clipping or horizontal overflow.

`artifacts/model-picker-runtime-receipt.json` records the full final native smoke:
actual foreground/background/stop operations, file changes and diff controls,
queued turns, review/queue restoration, history reopening, IME, keyboard,
appearance, responsive menus and stable composer focus. The selected model
reaches the real kernel. Matching conversation screenshots use the
`model-picker-conversation-*` names.

The actual Windows preview is visible and responding with this built renderer
and the WSL CLI backend. Its screenshot/receipt use `model-picker-windows-*` names.
No model prompt was submitted to the user's backend. This remains a source
preview, not a native installer or a Windows-native CLI distribution.

Full workspace typecheck, lint, build and tests passed during this change
(SDK 9,644; CLI 4,704, with five existing skips; desktop 28). Subsequent renderer
refinements passed scoped desktop typecheck, lint/build and both native proofs;
the six test-identity syntax corrections passed the seven catalogue regressions.
Docs conformance/fences, external-name and log-standard checks passed. Existing
CLI lint warnings and bundler directive notices remain warnings. Earlier
48-gate receipts describe earlier commits; this local UI change does not claim
those gates or publication.
