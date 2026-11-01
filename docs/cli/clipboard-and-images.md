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
- Linux tries `xclip`, then `wl-paste`.
- Windows runs a fixed PowerShell script.
- WSL tries the Linux tools, then runs the same PowerShell script through Windows interop. It looks for `powershell.exe` on the `PATH`, then at its fixed place under the Windows drive mount (`/mnt/c/...`, or the `[automount] root` of `/etc/wsl.conf`). The script prints the image on standard output, so nothing is written to a Windows temp file. An image taller or wider than 2000 pixels is shrunk first. If the clipboard holds image files copied in Explorer, those files are attached.

The script is fixed text. No part of the clipboard or of anything you type is placed in a command line.

## Pasting file paths

A paste made only of paths to `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp` files, such as a file dragged onto the terminal, attaches the files instead of inserting text. Quoted and backslash-escaped paths work, and several paths make several chips. On Windows and WSL, `C:\...` paths and paths on this distribution's own share (`\\wsl$\<distro>\...`, `\\wsl.localhost\<distro>\...`) are converted. Each file must start with image bytes and be under 64 MiB.

If any piece of the paste is not a readable image, the whole paste is inserted as ordinary text.

## Messages

| Message | Meaning |
|---|---|
| No image found in the clipboard. Copy one, then press ... | A reader ran and the clipboard has no image. |
| No image over SSH. Copy the file over, then paste its path. | Same, in an SSH session. |
| Can't reach the Windows clipboard from here. Check that Windows interop is on ... | WSL, and `powershell.exe` could not be started. |
| Reading the clipboard took too long. Try again, or paste the file's path. | The reader did not finish in time (10 seconds for PowerShell, 3 for the Linux tools). |
| Cannot read images from the clipboard here ... | No clipboard tool exists on this machine; install `xclip` or `wl-clipboard`. |

## Limits

An image whose base64 form is over 5 MiB is refused at paste time with a message to save a smaller copy and paste its path. Images are otherwise sent as they are; there is no resizing beyond the 2000-pixel shrink on the Windows clipboard route, and BMP clipboards are not converted.

Pasted file paths are read without a permission check; only files that start with image bytes are attached. If the clipboard reader fails for a reason other than "no image" (for example PowerShell blocked by policy), the message says it could not read the clipboard rather than that it was empty.
