---
type: Reference
title: MCP content blocks
description: Which MCP tool-result content types reach the model, which protocol revision introduced each, and how audio, resource_link and embedded resources are represented once mapped onto a ToolResult.
resource: packages/sdk/src/connector/mcp/adapter.ts
tags: [sdk, mcp, connector, tool-result]
status: stable
generated: { by: process:claude-code, at: 2026-09-16T00:00:00Z }
---

# MCP content blocks

`mcpToolResultToToolResult` (`packages/sdk/src/connector/mcp/adapter.ts`) converts an MCP server's `tools/call` result into the kernel's `ToolResult`. This page names every content block type it understands, which protocol revision introduced each, and exactly what a model sees for it.

## Per-era introduction

| Content block | Introduced | namzu handling |
| --- | --- | --- |
| `text` | 2024-11-05 (base protocol) | Joined with `\n` into `output`. |
| `image` | 2024-11-05 (base protocol) | Admitted (see below) and, when admitted, passed as a real `ToolResultBlock` the provider can render. |
| `resource` (embedded) | 2024-11-05 (base protocol) | `text` renders as model-visible text; `blob`-only or URI-only is a pointer the model cannot dereference and is left out of visible content. |
| `audio` | 2025-03-26 | Admitted (see below); named by media type in `output` when admitted. No raw-byte carrier yet — see [Known gap](#known-gap-audio-has-no-toolresultblock-carrier). |
| `resource_link` | 2025-06-18 | Always rendered as a named pointer; never fabricated as content, since the block itself carries none. |
| `structuredContent` (result-level, not a content block) | 2025-06-18 | Serialized into `output` only when no `text` block is present — see [Text vs. structured content](#text-vs-structured-content). |
| `annotations` (on `resource`) | 2025-06-18 | Carried through untouched into `ToolResult.data`; namzu does not act on them. |

Because namzu widened `MCP_SUPPORTED_PROTOCOL_VERSIONS` to reach these revisions (see the era-negotiation work landing in the same release), a server that previously spoke 2024-11-05 by default may now answer with any of these block types the moment it negotiates a later era — this page is what changed on the receiving end to keep up.

## Admission: image and audio

Both `image` and `audio` blocks carry a server-declared MIME type and base64 bytes namzu did not produce. `admitMcpImageBatch` (`image-admission.ts`) and `admitMcpAudioBatch` (`audio-admission.ts`) decode canonical base64, then require the bytes to form a complete, correctly-framed container matching the declared type:

- Images: `image/png`, `image/jpeg`, `image/gif`, `image/webp`.
- Audio: `audio/wav` (RIFF/WAVE), `audio/ogg` (Ogg page framing), `audio/mpeg` (MPEG-1 Layer III frames). Any other declared audio media type — including `audio/flac` — is refused outright, the same policy an unsupported image media type gets.

Neither validator decodes pixels or samples; they check that the container's own length-prefixed structure is internally consistent and consumes the buffer exactly, with no trailing or missing bytes. The Ogg validator does not verify page checksums; the MP3 validator accepts MPEG-1 Layer III only.

Admission is atomic per batch: one malformed block withholds every block of that type in the same result, so a model is never shown a partial batch. A withheld batch still reaches `ToolResult.data` in full — only the model-visible surface (`output` for audio, `content` for images) is affected — and produces a bracketed notice:

```
[MCP image batch withheld from model input: one or more blocks are not complete supported raster containers matching their declared media types.]
[MCP audio batch withheld from model input: one or more blocks are not complete supported audio containers matching their declared media types.]
```

An admitted audio batch instead produces `[MCP audio: <mimeType>[, <mimeType>...]]`.

## Known gap: audio has no `ToolResultBlock` carrier

`ToolResultBlock` (`packages/sdk/src/types/message/index.ts`) is `text | image | document` — there is no `audio` member, and none of namzu's provider drivers accept audio tool-result input today. An admitted audio block is therefore named by its media type in `output` rather than being handed to a provider as playable bytes; the raw base64 is never dumped into text, which is the exact mistake this adapter already fixed once for screenshots (see the module doc on `ToolResultBlock`). Widening `ToolResultBlock` with a real audio carrier, and wiring at least one provider driver to accept it, is future work and is out of scope here.

## `resource_link` is a named pointer

A `resource_link` block never carries content — only `uri`, `name`, and optionally `description`/`mimeType`. Rendering it as anything but a name would be fabricating content the server never sent, so it becomes a single text block:

```
[MCP resource link: <name> (<uri>)]
```

This is consistent with how a URI-only embedded `resource` (no `text`, no `blob`) has always been handled: left out of model-visible content rather than invented.

## Embedded resources: `blob` and `annotations`

The `resource` variant now accepts an optional `blob` (base64, for a binary embedded resource) alongside the pre-existing `text`, and an optional `annotations` object (`audience`, `priority`, `lastModified`, per the schema since 2025-06-18). Handling:

- `text` present → rendered as model-visible text, as before.
- `blob` present, no `text` → not rendered as text (binary bytes are not readable text, and nothing decodes them), not thrown — it is a pointer the model cannot read, same as a URI-only resource. The raw block, `blob` included, still reaches `ToolResult.data`.
- `annotations`, when present, are never inspected or acted on. They survive verbatim into `ToolResult.data` because `data` always carries the server's raw content array; no dedicated code path was needed to preserve them.

The working-state pin path (`WORKING_STATE_MIME`) is unaffected by any of this — it is matched and consumed before the general `resource` branch runs, exactly as before.

## Text vs. structured content

Unchanged by this work, restated for completeness: when a server answers with `structuredContent` and no `text` block, the structured payload is serialized into `output` so the call does not look like it returned nothing. A `text` block, when present, always wins — it is what the server wrote for the model, and duplicating both would spend context saying the same thing twice.

## A note on the exported union

`MCPContentBlock` is part of `@namzu/sdk`'s public surface. Adding `audio` and `resource_link`, and widening `resource`, is an **additive** change to an **output** type — but a consumer that pattern-matches this union exhaustively (`switch (block.type) { ... default: assertNever(block) }`) will fail to compile against the new members until it adds cases for them. That is a real compile-time break for that shape of consumer, even though nothing at the value level is removed or renamed. It rides the same major-version release as the protocol-era negotiation work, since that work is what makes servers start sending these block types in the first place.
