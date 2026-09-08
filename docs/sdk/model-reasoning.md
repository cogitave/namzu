---
type: Reference
title: Model-owned reasoning capabilities
description: Exact effort metadata shared by model catalogues and host controls.
resource: packages/sdk/src/types/provider/model.ts
tags: [sdk, providers, reasoning, cli]
---

# Model-owned reasoning capabilities

`ModelInfo.reasoningEffortLevels` optionally publishes the exact ordered effort
menu for a model on its provider route. An absent value means unknown; an empty
array means no selectable effort. `ModelInfo.reasoningEffortDefault` optionally
publishes the default and must belong to the menu when both are supplied.
These fields do not imply that the provider supports every SDK effort value.

The CLI first asks the selected model and usable fallback routes for their
model-specific capability hooks. A known answer, including an empty menu, needs
no extra network request. For unknown menus it discovers catalogues under a
bounded side-call deadline and reads the exact model row. Driver hooks remain
the fallback when metadata is absent or discovery fails. The legacy `effortLevelsFor` hook is only used when the canonical hook is
absent. No model-name guessing or common menu is substituted for unknown data.

Malformed menus and conflicting duplicate model rows remain unknown. Missing or
invalid defaults do not suppress a valid menu. The selectable session menu is
the intersection of usable fallback routes; an unknown fallback cannot prove a
safe common menu. Defaults are offered only when all routes agree.

Provider adapters remain responsible for translating vendor catalogues into
these fields and enforcing their transport contract. OpenAI API model listings
do not publish the same metadata as Codex subscription listings, so the API
driver can still use its model-specific capability hooks. A shared model name
does not establish identical effort support across different service routes.

Discovery is performed when constructing the session; this is a snapshot, not
a live catalogue subscription. The generic CLI mechanism does not itself add
effort support to drivers whose protocol mapping lacks it.
