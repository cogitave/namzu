---
'@namzu/sdk': minor
'@namzu/cli': patch
'@namzu/anthropic': patch
'@namzu/bedrock': patch
'@namzu/deepseek': patch
'@namzu/http': patch
'@namzu/lmstudio': patch
'@namzu/ollama': patch
'@namzu/openai': minor
'@namzu/openrouter': patch
---

Add separate provider capability declarations for image and document tool
results, and warn immediately before a request would degrade newly produced
rich tool output. Tool presenters can now mark a generic label as a complete
activity and mark a redundant successful acknowledgement as hidden; older
hosts continue to render the same generic label.

The account-routed Responses transport now sends supported user images and
image tool results as ordered image input parts. Documents, unresolved stored
references, unsupported image media types and unprojected omission markers are
refused before transport.

The interactive transcript now follows the visible conversation tail without
a synthetic viewport-height gap, responds to terminal resize, narrates desktop
actions with human labels, hides only successful empty acknowledgements, and
keeps screenshot dimensions and failures visible.
