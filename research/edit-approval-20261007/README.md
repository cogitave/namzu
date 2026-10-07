---
type: Research
title: Edit approval card
description: Proof for the Codex-style file-change approval card, its preview wire field and answer-with-feedback.
tags: [desktop, approvals, acp]
---

# Edit approval card, 2026-10-07

Reference: Codex's file-change approval (a diff box over a right-aligned wrap toggle, Edit, Reject in red, Accept in green).

## What was proved

- Unit: `packages/sdk/src/tools/builtins/__tests__/an-edit-can-be-dry-run.test.ts` (each edit shape), `packages/sdk/src/bridge/acp/__tests__/permission-and-filesystem.test.ts` (the wire carries `preview`), `packages/cli/src/commands/__tests__/permission-preview.test.ts` (edit shapes, write new and existing, 1 MiB cap, binary, outside root, no-op), `packages/desktop/src/main/operator.permission.test.ts` (feedback round trip through the operator against the RPC fixture, malformed preview dropped, 4,000-character cap, note refused on approve), `packages/desktop/src/renderer/approval-card-model.test.ts` (titles, counts, fragments, other tools), `packages/desktop/src/shared/permission-protocol.test.ts`.
- Browser: `capture.mjs` drives the live preview (`window.namzuPreviewApproval.raise(kind)`), 30 checks, output in `capture-output.txt`. Dark 1440x900 and light 900x720, Edit mode and wrap on included. Screenshots are in `artifacts/`.

## Findings

- The diff element draws on the render after it mounts. Nothing re-renders a card that waits for an answer, so the card forces one extra render (`composer-approval.tsx`, `redraw`). Without it the diff box stayed empty until the wrap toggle was pressed.
- Dark Reject text is 4.57:1 against `--surface-raised`, Accept 10.0:1; light Reject 6.26:1, Accept 6.45:1. The card surface is translucent glass, so these are measured against the token, not a pixel.
- Point 4 (declined row after reload) does NOT hold. The note reaches the model as the tool result (`Error: Tool "edit" was not executed. <note>`), and live it shows as the row label. A reload rebuilds rows from `tool_completed` records, and a denial's record carries no `presentation` (`recordDenial` in `packages/sdk/src/runtime/query/executor.ts`, `resultPresentation` only keeps a `cancelled` view), so `desktop-host.ts` marks the row `detailUnavailable`. Fix, not built here: have `recordDenial` attach `{ kind: 'generic', label: <reason>, outcome: 'cancelled' }`; that turns every denied call (policy ones too) from "failed" into "cancelled" in history, which is why it needs its own review.
- The Codex and Claude Code engines send no preview; the card shows the call's own fragment under "Preview not available".

## Re-run

Keep `pnpm --filter @namzu/desktop dev` up, then `node research/edit-approval-20261007/capture.mjs`.

## Adversarial review (2026-10-07)

- Differential test `a-dry-run-equals-a-real-edit` (SDK): 20 shapes (CRLF, mixed endings, replace_all, batch, inserts, BOM, `$` patterns, refusals) give the same body from `dryRunEdit` and a real `EditTool.execute`.
- CLI test: a symlinked file or directory leaving the roots gets no preview; a CRLF file previews with its CRLF kept.
- Fixed: after a failed or refused answer the card stayed dead (one-answer latch never released); it now takes another try. The "back to Edit" focus after Escape moved from a frame callback to an effect. The +N/-M counts are now green/red (6.4 to 6.6:1 light, 6.2 to 13.5:1 dark).
- Left: point 4 (note after reload) is the existing rule that history keeps no view for a failed call except "cancelled"; a fix needs SDK `recordDenial` to tell a person's No from a policy refusal.
