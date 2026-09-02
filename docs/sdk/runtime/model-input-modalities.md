---
title: Provider capabilities and model input modalities
description: Reference for the difference between a driver's ability to map rich input and the input kinds accepted by one listed model, including the honest meaning of absent model metadata.
type: Reference
status: stable
resource: packages/sdk/src/types/provider/model.ts
tags: [sdk, providers, models, images, documents]
generated: { by: human:bahadirarda, at: 2026-08-22T00:00:00Z }
---

# Provider capabilities and model input modalities

Image and document support has three independent parts:

- `supportsVision` and `supportsDocuments` say whether the driver maps a rich
  user-message input onto its wire protocol.
- `supportsToolResultImages` and `supportsToolResultDocuments` say whether the
  driver's function-result wire can return that rich content to the model.
- `ModelInfo.inputModalities` says which input kinds one exact listed model is
  known to accept.

A driver can therefore declare `supportsVision: true` while listing a mix of
text-only and image-capable models. The declaration is honest because the
driver has an image projection; the model metadata prevents a menu or host from
assuming every route behind it accepts that projection.

User input and tool results are separate because several protocols accept an
image in a user message while restricting function output to text. Treating
`supportsVision` as permission for both silently loses screenshots at exactly
the point where a desktop agent needs to inspect them.

```ts
import type { LLMProvider, ModelInfo } from '@namzu/sdk'

declare const provider: LLMProvider

const models: ModelInfo[] = await provider.listModels?.() ?? []
for (const model of models) {
  if (model.inputModalities?.includes('image')) {
    console.log(`${model.id} accepts image input`)
  }
}
```

The admitted values are `text`, `image`, and `document`. The field is optional.
Absent means the listing did not establish the answer; it does **not** mean
text-only. A host may show a positive image/document marker from an explicit
value, but must not fabricate a negative capability from absence.

Driver capability negotiation remains the run-level safety boundary. Initial
user attachments are checked before the run. Tool-result blocks do not exist
until execution, so the runtime checks the exact post-budget request immediately
before every provider call and emits one `capability_warning` per new unsupported
block. `strictCapabilities: true` fails the run before that request instead.
A driver serving mixed models must additionally refuse a rich input before
transport when the selected model is known not to accept it. Model metadata is
a menu and discovery contract, not permission to silently discard bytes.
