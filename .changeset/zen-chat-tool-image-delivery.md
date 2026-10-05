---
"@namzu/zen": patch
---

Deliver screenshot and saved-image tool results to Chat Completions models as
real, attributed image content after the complete tool-result batch. Previously
these results failed local history conversion, despite the driver's advertised
image capability, stopping Space Bunny Pal work after its first screenshot.

Preserve original tool IDs, text and failure markers; leave the durable journal
and operator messages unchanged. Images with persisted delivery omissions stay
omitted, and text-only histories keep their previous request shape. The model
must support image input; chat tool documents remain explicitly unsupported.
