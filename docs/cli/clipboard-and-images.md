---
type: Reference
title: Pasting images into the composer
description: Which key pastes an image on each platform, how it reaches the Windows clipboard from WSL, what a paste of file paths does, and what each message means.
resource: packages/cli/src/integrations/clipboard/image.ts
tags: [cli, composer, clipboard, images, wsl]
status: stable
generated: { by: human:bahadirarda, at: 2026-11-02T00:00:00Z }
---

# Pasting images into the composer

An image in the composer is a chip, `[Image #1]`, in the text of the draft. It travels beside the message when you send it. Deleting the chip drops the image.

## Keys

| Where you run Namzu | Key |
|---|---|
| macOS, Linux | `ctrl+v` (and `alt+v`) |
| Windows | `alt+v` (`ctrl+v` stays the terminal's own text paste) |
| WSL | `ctrl+v` and `alt+v` |

`alt+v` is always bound, because some terminals keep `ctrl+v` for themselves. Both keys are rebindable as the `chat:imagePaste` action. The message shown when nothing was pasted names the key that works on your platform.

On macOS and WSL a terminal also sends an empty paste when the clipboard holds only an image (Windows Terminal does this for a screenshot). Namzu treats that empty paste as the same request, so pasting with the terminal's own shortcut works without a key.

A second press while a read is running is ignored. Enter pressed meanwhile waits for the read to end, so a message is never sent before its image exists. A read that takes longer than a moment shows "Reading the clipboard...".

## How the image is read

- macOS asks the system for the clipboard's PNG.
- Linux asks `xclip` and `wl-paste` what the clipboard holds, then reads PNG from either and, failing that, BMP (converted to PNG).
- Windows runs a fixed PowerShell script.
- WSL tries the Linux tools, then runs the same PowerShell script through Windows interop. It looks for `powershell.exe` on the `PATH`, then at its fixed place under the Windows drive mount (`/mnt/c/...`, or the `[automount] root` of `/etc/wsl.conf`). The script prints the image on standard output, so nothing is written to a Windows temp file. An image taller or wider than 2000 pixels is shrunk first. If the clipboard holds image files copied in Explorer, those files are attached.

When a key press finds no image, Namzu pastes the clipboard's text instead, so a terminal that hands the key to the application rather than pasting loses nothing. The text read is given 2 seconds; text that is really binary (it holds a NUL, or more than 5% of its first 4096 characters are replacement characters) is not pasted. An empty bracketed paste does not do this, because it already carried no text.

The script is fixed text. No part of the clipboard or of anything you type is placed in a command line.

## Pasting file paths

A paste made only of paths to `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp` files, such as a file dragged onto the terminal, attaches the files instead of inserting text. Quoted and backslash-escaped paths work, and several paths make several chips. On Windows and WSL, `C:\...` paths and paths on this distribution's own share (`\\wsl$\<distro>\...`, `\\wsl.localhost\<distro>\...`) are converted. Each file must start with image bytes and be under 64 MiB.

A path answers to the same read policy as the `read` tool. A permission rule that denies or asks about the path refuses it, and so does a path outside the working directory and the folders added with `/add-dir`; the message says which, and the path is left in the draft as text. To attach an image from elsewhere, add its folder with `/add-dir` or copy the image into the project. A path that does not exist or cannot be read is not an image to refuse; it stays in the draft as text. "Don't ask again" answers given in earlier prompts are not consulted for this check, so an image kept outside the folders is attached only after its folder is added.

If any piece of the paste is not a readable image, the whole paste is inserted as ordinary text.

## Messages

| Message | Meaning |
|---|---|
| No image found in the clipboard. Copy one, then press ... | A reader ran and the clipboard has no image. |
| No image over SSH. Copy the file over, then paste its path. | Same, in an SSH session. |
| Can't reach the Windows clipboard from here. Check that Windows interop is on ... | WSL, and `powershell.exe` could not be started. |
| Reading the clipboard took too long. Try again, or paste the file's path. | The reader did not finish in time (10 seconds for PowerShell, 3 for the Linux tools). |
| Cannot read images from the clipboard here ... | No clipboard tool exists on this machine; install `xclip` or `wl-clipboard`. |
| This image is too large to attach and image resizing is unavailable. ... | The image is over the limits and the optional image library is not installed. |
| This image is too large to attach, even after shrinking it. ... | Even the smallest form still does not fit; save a smaller copy. |
| This image format needs image processing, which is unavailable here. ... | A BMP (or other non-web format) arrived and the optional image library is not installed. |
| A permission rule keeps this session from reading ... / ... is outside the folders this session can read. | A pasted path was refused by the read policy. |

## Limits

Every image is brought inside what a provider accepts before it is attached: at most 2000 pixels on a side, 3.75 MiB of image data (5 MiB once encoded as base64). A PNG, JPEG, GIF or WebP inside those limits is attached byte for byte. A larger one is scaled to fit inside 2000 by 2000 (never enlarged); if it is still too heavy it is tried as a palette PNG, then as JPEG at quality 80, 60, 40 and 20, and last as a JPEG 1000 pixels wide at quality 20. BMP and any other format become PNG first. A resized photo is turned upright first (its orientation tag is applied to the pixels and dropped), so a phone photo is not sideways. An animated GIF inside the limits is attached as it is; one that would need shrinking is refused, because shrinking would keep only its first frame. An image that still does not fit is refused with a message to save a smaller copy and paste its path.

Shrinking and converting use [sharp](https://sharp.pixelplumbing.com/), an optional dependency of `@namzu/cli` that is loaded the first time it is needed (an image whose own header shows it is inside the limits never loads it). If it is not installed, because the platform has no prebuilt binary or optional dependencies were skipped, the CLI still starts and still attaches images that are inside the limits; larger images and BMPs are refused with a message saying why.

Setting `NAMZU_NO_CLIPBOARD=1` stops Namzu from starting any clipboard program (`xclip`, `wl-paste`, `pbpaste`, `osascript`, PowerShell). Clipboard reads then report that no tool is available. The test suite sets it so no test can reach a real clipboard.

If the clipboard reader fails for a reason other than "no image" (for example PowerShell blocked by policy), the message says it could not read the clipboard rather than that it was empty.
