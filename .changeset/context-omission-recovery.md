---
"@namzu/sdk": patch
---

Correct recovery instructions when tool-result images or documents are omitted from model context. Payload limits, invalid images and provider-image rejection no longer instruct an agent to repeat the producing tool, which may have changed external state. Accompanying result text and original history remain intact; recovery guidance uses an available artifact or read-only observation without claiming a recovery tool exists.
