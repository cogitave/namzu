---
"@namzu/zen": patch
---

Encode Responses requests with `toolChoice: 'none'` by omitting both tool definitions and the tool-choice field. This preserves the no-tools constraint while avoiding a Muse HTTP 400 during budget/time finalization. Required and named tool choices remain explicit, and other protocol routes retain their encoding.
