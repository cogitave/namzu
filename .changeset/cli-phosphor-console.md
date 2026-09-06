---
"@namzu/cli": patch
---

Give the terminal a phosphor-green identity with a compact NAMZU wordmark and a square message frame. Explicit palette indices keep colors consistent on 256-color terminals. The frame preserves input space and draft state, remains active while steering a running turn, and disappears when a text prompt owns input. Existing commands and keyboard bindings are unchanged.

Keep the transcript's scrollback owner mounted during initial provider selection. Previously, entering the credential picker could leave the renderer reading a freed layout node on exit and exhaust the process heap.
