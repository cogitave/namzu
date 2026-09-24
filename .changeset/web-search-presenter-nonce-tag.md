---
"@namzu/cli": patch
---

`web_search`'s transcript presenter stripped the untrusted-content envelope from its own tool result by matching the frame's literal opening/closing tags by hand. `@namzu/sdk`'s `wrapUntrusted` now binds those tags to a per-render nonce (see the `@namzu/sdk` major changeset in this same release), so the hand-rolled match would have silently stopped recognizing the envelope and shown the raw, tagged text in the transcript instead of the clean result. The presenter now reads the body back with the exported `untrustedEnvelopeBody`, which already understands the nonce, instead of re-deriving the tag shape.
