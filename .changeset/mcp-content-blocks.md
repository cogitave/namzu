---
"@namzu/sdk": minor
---

`MCPContentBlock` gains `audio` (`{ type: 'audio', data, mimeType }`, part of the schema since 2025-03-26) and `resource_link` (`{ type: 'resource_link', uri, name, description?, mimeType? }`, since 2025-06-18), and the existing `resource` variant gains optional `blob?` (a binary embedded resource) and `annotations?` (a new `MCPContentAnnotations` type: `audience`, `priority`, `lastModified`). `mcpToolResultToToolResult` now renders all of it instead of silently dropping it: an admitted `audio` clip is named by its media type in the tool result's `output`; a malformed audio batch is withheld with a notice, atomically, the same as the existing image-admission behavior (new `audio-admission.ts`, supporting `audio/wav`, `audio/ogg` and `audio/mpeg`); a `resource_link` is rendered as a named pointer (`[MCP resource link: <name> (<uri>)]`) since it carries no content to show; a `resource` with `blob` and no `text` no longer risks mishandling — it is left out of model-visible content without throwing, consistent with how a URI-only resource has always been handled; `annotations` pass through untouched into `ToolResult.data`.

Minor by the letter of the rule — every change here is additive — but read this if your code pattern-matches `MCPContentBlock` exhaustively (a `switch` with a `default: assertNever(block)` or equivalent): it will fail to compile until you add cases for `audio` and `resource_link`. Add a case (or a catch-all) for each before taking this upgrade if you switch over this union anywhere.

This is meant to ship in the same release as the MCP protocol-era negotiation work: namzu now reaches servers that negotiate past 2024-11-05, and those servers are the ones that actually send these block types.
