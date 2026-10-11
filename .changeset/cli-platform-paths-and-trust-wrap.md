---
"@namzu/cli": patch
---

On Windows, folders in the terminal app's sentences (the trust prompt, saved-file notices, `/status`) use backslashes like the footer does (`~\Work\clients\leaf-folder`). The trust prompt now wraps to the box's real width, so at 54 columns it no longer leaves "files" alone on a line, and its title, sentences and key line break evenly at every width from 40 up. Nothing to change on your side.
