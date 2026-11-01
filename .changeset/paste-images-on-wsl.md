---
"@namzu/cli": minor
---

Pasting an image into the composer now works under WSL. Namzu reads the Windows clipboard through `powershell.exe` (found on the `PATH`, or at its fixed place under the Windows drive mount), and an empty terminal paste, which Windows Terminal sends for an image-only clipboard, attaches the image too. A paste made only of paths to image files, such as a dragged file or a `C:\...` path, attaches the files. Reading the clipboard no longer freezes the composer, and Enter pressed during a read waits for it. On Windows the image key is now `alt+v` only (`ctrl+v` stays the terminal's text paste); macOS and Linux keep `ctrl+v` and `alt+v`, and WSL binds both. If you rebound `chat:imagePaste` your binding is untouched. If `powershell.exe` cannot start, you get a message about Windows interop instead of a missing-tool hint.
