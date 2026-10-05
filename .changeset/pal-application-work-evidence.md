---
"@namzu/sdk": major
"@namzu/cli": major
"@namzu/sandbox": minor
---

Ready-computer Pal prompts now default to general application work guidance:
understand references and acceptance criteria, make reversible changes,
observe and correct the actual result, and validate saved files and requested
exports before delivery. SDK hosts that need the previous prompt behavior can
pass `workGuidance: 'basic'` to `buildPalSystemPrompt`. This guidance shapes
model behavior; it does not certify semantic correctness.

The SDK `read` tool now refuses real PNG, JPEG and WebP bytes as text. Mount
the optional `view_image` / `createViewImageTool` for saved-image inspection,
or use a format-aware binary reader when pixels are not the desired result.
`getBuiltinTools()` retains its previous tool roster. Saved artifact images
provide no GUI screenshot authority.

The CLI and desktop Pal runtime now explicitly mount `view_image` and
`import_reference_images`. Image import is a reviewed file-write operation
using only the current operator input and admitted guest. Original image
bytes and manifests survive durable review; current plan, pause and control
guards remain in force. Ordinary chat and unavailable-computer sessions do
not acquire guest tool access.

The local Pal sandbox adds authenticated, acknowledged bounded byte reads.
Rebuild the local Pal image from this release to inspect saved images; an
older worker fails explicitly before file contents are requested. Existing
whole-file requests and generic worker defaults are unchanged.

The Pal image also includes the standard `file` utility for format checks.
This reports file type; it does not establish application or visual quality.
