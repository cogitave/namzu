---
"@namzu/cli": minor
---

Read and dispatch Pal messages, authorized activity observations and authenticated channel messages through one SDK ledger. `namzu pal inbox` preserves existing peer row fields and adds explicit source metadata for observation/channel rows without exposing message bodies. Pal sessions and finite dispatch check source-specific current consent; channel execution denies unless a trusted host adapter is explicitly injected.
