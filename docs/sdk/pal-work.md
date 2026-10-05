---
type: Reference
title: Pal application work and visual evidence
description: Shared application work guidance, reviewed import of original reference images and explicit inspection of saved image artifacts.
resource: packages/sdk/src/pals/prompt.ts
tags: [sdk, pals, applications, references, visual-evidence]
status: stable
---

# Pal application work and visual evidence

A Pal can combine an application's API or scripts with its GUI. The SDK's
shared guidance applies to graphics, documents, spreadsheets, browsers, code
and other applications. It does not require a particular application, a fixed
sequence of mouse actions or a setup form before ordinary conversation.

## Observe, act, compare and correct

`buildPalSystemPrompt(definition, options)` includes the application work
guidance when `options.computer.status` is `ready`. Its default
`workGuidance` is `observe-verify`; `basic` omits that guidance while retaining
the saved identity, conversation style and existing computer-access statements.
Unknown values are refused. An unavailable computer supplies no application
work guidance or computer authority.

The guidance asks the model to:

1. Understand the requested outcome, supplied references, constraints and
   current document. Establish meaningful acceptance criteria from the actual
   task, and clarify only decisions that materially affect the result.
2. Choose a reliable supported interface. Inspect the installed version and
   document before relying on an API; combine precise automation with GUI
   inspection where appropriate.
3. Make small, reversible changes. Preserve originals and useful intermediate
   states when needed, and confirm a backup exists before claiming one.
4. Observe the resulting artifact or application state, compare it with the
   acceptance criteria and correct observed mismatches. Use relevant alternate
   views, content checks, calculations or functional tests.
5. Verify the saved native result and requested exports using their real
   reader or application when practical. Report what was actually produced,
   inspected and tested, with any concrete remaining limitation.

These are model instructions, not a deterministic correctness guarantee. They
do not grant permissions, invoke tools, create backups, force a render or
certify production quality. Tool success, a zero shell exit code, file presence
and non-empty bytes do not establish visual, semantic or application-level
correctness. `verify_outputs` checks file presence; it does not establish
whether the output satisfies the task. A conversation checkpoint does not
prove that the application saved its document.

For example, an embedding host can keep the earlier basic prompt behavior:

```ts
import { buildPalSystemPrompt } from '@namzu/sdk'

const systemPrompt = buildPalSystemPrompt(
  { name: 'Researcher', purpose: '' },
  {
    computer: { status: 'ready', workingDirectory: '/home/namzu/workspace' },
    workGuidance: 'basic',
  },
)
```

The host must describe computer access only after actual admission. See
[Pal admission](pals.md) and [local Pal computers](local-pal-computer.md).

## Original reference images in the guest

An inline image visible to a model is not automatically a file in its
computer. `preparePalReferenceImages(attachments)` validates the complete
current input batch before guest I/O. It accepts original inline PNG, JPEG,
WebP and GIF attachments, ignores documents, and refuses unresolved stored
image references. It performs no URL downloads or host-file lookup.

The batch limits are eight images, 3 MiB per image and 12 MiB total. Base64 must
be canonical; the raster container must be complete, supported, bounded and
consistent with its declared media type. Validation does not certify that the
reference depicts the intended subject or that all compressed pixels decode
successfully in the target application.
Raster admission limits each edge to 16,384 pixels and the image to 40 million
pixels; the stricter saved-image inspection limits below still apply to
`view_image`.

`PalReferenceImage` retains `attachmentIndex`, `mediaType`, original base64
`data`, SHA-256 and decoded byte count. `attachmentIndex` is one-based in the
original attachment array, including non-image attachments. The prepared
batch does not mutate that array or invent a user filename.

`importPalReferenceImages(references, options)` uses only the explicitly
supplied `Sandbox`. `PalReferenceImageImportOptions` requires `sandbox` and
`assertCurrentAdmission`, and accepts an optional cancellation `signal`.
The callback must reread the current computer and write authority before each
operation. The helper is a writer: a host calling it directly must first admit
that exact file-write operation under its own permission policy.

The implementation requires an owned POSIX guest working directory and
Python 3 with its POSIX standard-library filesystem operations. The shipped
Linux Pal image provides these. A missing guest interpreter or an incompatible
guest fails explicitly; the helper does not execute its import script on the
operator's computer as a fallback.

Confirmed files have content-addressed names:

```text
<guest-root>/.namzu/references/<sha256>.png
<guest-root>/.namzu/references/<sha256>.jpg
<guest-root>/.namzu/references/<sha256>.webp
<guest-root>/.namzu/references/<sha256>.gif
```

The guest verifies the staged original bytes and the published file before
acknowledging the manifest. It uses directory descriptors, rejects reference
store symlinks and publishes new files exclusively. A matching file is reused;
a conflicting existing file is refused without overwriting it. New files are
read-only as protection against accidental edits. That mode is not a security
boundary against another process with the same guest user identity.

Each `PalReferenceImageImportReceipt` contains `attachmentIndex`, `mediaType`,
`sha256`, `bytes` and the confirmed guest `path`, without embedding the image
data again. The receipt proves the original bytes were present at publication;
it does not prove that an application loaded them or that the produced output
matches them. Application loading and comparison still need actual observation.

An interrupted operation can leave scratch files under
`<guest-root>/.namzu/reference-imports/`. Revoked authority never grants a new
cleanup operation. Scratch is not a confirmed reference manifest, and retrying
an admitted import reconciles matching published content without replacement.

### Reviewed reference import tool

`createPalReferenceImageTool(options)` returns `import_reference_images`, with
empty input `{}`. `PalReferenceImageToolOptions` requires a host-owned
`attachments()` callback for the current operator input and an
`assertCurrentAdmission(context)` callback. The model cannot supply a host
path, filename, URL or base64 payload to this tool.

It declares `file_write`, is not read-only and passes through the ordinary
tool authorization and review policy. Direct execution also refuses a current
plan permission context. The host must continue to enforce pause, takeover,
generation, scope and changing permission policy through its admission
callback. Mounting the tool does not import anything; an actual authorized
call is required.

The CLI captures the current operator input separately from cached history.
New turns do not silently import old attachments. A durable resumed tool review
recovers the original attachments from that exact turn's journal; existing
tool receipts and checkpoint messages retain their confirmed manifests.
Original user attachment bytes and history are not rewritten to add paths.

## Inspecting saved image artifacts

`createViewImageTool(options?)` returns `view_image`; `ViewImageTool` is the
default instance. Both are optional tools that a host mounts explicitly.
`ViewImageToolOptions.unavailableReason` disables the tool before any file is
read or image is shown. Hosts should use the actual provider's image-result
capability when selecting that option.

The model calls `view_image` with `{ path }`. It declares `file_read`, is
read-only and follows the turn's file roots and reviewed-path policy. A
sandboxed turn reads only through its sandbox; it never falls back to the host
when that read fails. An ordinary unsandboxed host can explicitly mount it over
its own admitted file roots.

The tool returns real image content blocks, not base64 described as text. It
accepts static PNG, JPEG and WebP files up to 16 MiB, with dimensions at most
16,384 pixels per edge and 16 million pixels total. Unsupported types,
animated PNG/WebP, malformed containers and excessive inputs are refused.
Renaming a file does not convert its bytes.

PNG pixels are decoded and fitted to `STANDARD_SCREENSHOT_LIMITS`, preserving
aspect ratio. Interlaced PNGs below 8-bit depth are refused with a conversion
request because the installed decoder cannot preserve those pixels correctly;
export a non-interlaced or 8-bit PNG. JPEG and WebP containers and dimensions are validated without
decoding or resizing their compressed pixels; those files must already fit
the standard vision size. When resizing is needed, export a PNG or a smaller
JPEG/WebP. Model/provider delivery can still reject an image after tool
admission; an inspection claim needs actual delivered evidence.

Result metadata distinguishes source and delivered dimensions and includes
`sourceBytes`, the original file's `sha256`, detected `mediaType`, `sandboxed`,
`artifact: true` and `validation: 'decoded' | 'container'`. These fields describe
what was read and shown, not an automatic assessment of the image's quality.

A saved artifact image is separate from a live desktop frame. `view_image`
does not establish mouse-coordinate authority, advance the `computer_use`
screenshot sequence or confirm the application's current visible state. Before
GUI input, and after human control returns, acquire a fresh admitted
[`computer_use` screenshot](computer-actions.md). The operator's live viewer
does not count as a screenshot observed by the model.
