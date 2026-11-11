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

An image in the composer is a marker, `[Image #1]`, in the text of the draft. It travels beside the message when you send it. Deleting the marker drops the image.

A marker is one unit. The cursor never rests inside it: Left and Right step over it in one key, word jumps do not stop in it, and Backspace, Delete, Ctrl+W, Ctrl+K, Ctrl+U and Alt+D take all of it or none. Typing next to it never lands inside it, and undo brings a deleted marker back with its image. It is drawn in the colour the theme uses for system text (with colour off, the brackets still set it apart). Text that only looks like a marker, typed by hand or left over from an earlier message, has no image behind it and is ordinary text.

The number is the image's for the whole conversation. A new image takes the next number, a deleted marker's number is not reused, and after a resume numbering continues past the highest number the conversation already used. A document is `[Document #2]` and shares the count.

## What the sent message shows

The marker stays in the words, where you put it, both in the message row and in the text the model receives, so "compare [Image #1] with [Image #2]" means what it says. A message that is only an image is sent as its marker.

Under the message, one quiet row per attachment replaces a bare count: the marker, the file name when there is one (a clipboard image has none), and the size, as `[Image #1] shot.png · 48 KB`. Where the terminal takes hyperlinks (the check `terminalSupportsHyperlinks` makes for links in replies: not in tmux, screen or over SSH) the row is a link to a copy of the file, so a click opens it; elsewhere it is plain text. A conversation resumed with `/resume` or `-c` draws the same rows from its log with the same numbers.

The copy lives in `<NAMZU_HOME>/projects/<project>/<session-id>/attachments/`, inside the conversation's own folder, named by a hash of the bytes and a short extension. The same image attached twice is one file. Removing the conversation removes its folder and so the copies; nothing is written anywhere else. A conversation from before this change gets its copies the first time it is resumed. An attachment a store holds (`type: 'stored'`) has no bytes in the message, so its row has no size and no link.

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

A paste made only of paths to `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp` files, such as a file dragged onto the terminal, attaches the files instead of inserting text. Quoted and backslash-escaped paths work, and several paths make several markers. On Windows and WSL, `C:\...` paths and paths on this distribution's own share (`\\wsl$\<distro>\...`, `\\wsl.localhost\<distro>\...`) are converted. Each file must start with image bytes and be under 64 MiB.

A path is read wherever it lives, because you pasted it yourself: a screenshot on the Windows desktop (`C:\Users\...\Desktop\shot.png`, reached as `/mnt/c/...`) attaches like one in the project, and the folders added with `/add-dir` do not matter. One thing refuses it: a `read` permission rule that denies the path, or the file a link at that path leads to. Any deny wins, even when an allow rule for a narrower path sits beside it, and the rules are asked before the file is looked at, so a denied path is refused even if it does not exist. A rule that only asks does not refuse it. A refused path is not read, and is left in the draft as text with a message. A path no deny rule names that does not exist or cannot be read is not an image to refuse; it stays in the draft as text.

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
| A permission rule keeps this session from reading ... | A deny rule names the pasted path. |

## Limits

Every image is brought inside what a provider accepts before it is attached: at most 2000 pixels on a side, 3.75 MiB of image data (5 MiB once encoded as base64). A PNG, JPEG, GIF or WebP inside those limits is attached byte for byte. A larger one is scaled to fit inside 2000 by 2000 (never enlarged); if it is still too heavy it is tried as a palette PNG, then as JPEG at quality 80, 60, 40 and 20, and last as a JPEG 1000 pixels wide at quality 20. BMP and any other format become PNG first. A resized photo is turned upright first (its orientation tag is applied to the pixels and dropped), so a phone photo is not sideways. An animated GIF inside the limits is attached as it is; one that would need shrinking is refused, because shrinking would keep only its first frame. An image that still does not fit is refused with a message to save a smaller copy and paste its path.

Shrinking and converting use [sharp](https://sharp.pixelplumbing.com/), an optional dependency of `@namzu/cli` that is loaded the first time it is needed (an image whose own header shows it is inside the limits never loads it). If it is not installed, because the platform has no prebuilt binary or optional dependencies were skipped, the CLI still starts and still attaches images that are inside the limits; larger images and BMPs are refused with a message saying why.

Setting `NAMZU_NO_CLIPBOARD=1` stops Namzu from starting any clipboard program (`xclip`, `wl-paste`, `pbpaste`, `osascript`, PowerShell). Clipboard reads then report that no tool is available. The test suite sets it so no test can reach a real clipboard.

If the clipboard reader fails for a reason other than "no image" (for example PowerShell blocked by policy), the message says it could not read the clipboard rather than that it was empty.
