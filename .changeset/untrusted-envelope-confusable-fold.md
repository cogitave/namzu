---
"@namzu/sdk": patch
---

`neutralizeEnvelopeDelimiter` (and so `wrapUntrusted`, which uses it to defang its own delimiter in untrusted content and in a caller's `provenance`) used to match the closing token with a literal, ASCII, case-insensitive regex. A Unicode lookalike character — a non-breaking hyphen in place of the ASCII one, a fullwidth spelling of the letters, a zero-width or bidi-control character hidden inside the word — walked straight through without changing how a model reads the text as structure, letting untrusted content forge a fake close of the `<namzu-untrusted>` frame and have whatever followed read as unlabelled, trusted text.

The text is now folded first — NFKC normalization, dropped zero-width/bidi-control/variation-selector characters, every Unicode dash and space mapped to its ASCII form (`utils/confusable-text.ts`, new and internal) — before the keyword match runs. Content is emitted in its folded form; an exotic character that does not survive folding is not restored, an acceptable fidelity loss for text this envelope already frames as untrusted. No exported signature changes. A caller that already trusted this defense sees no behavior change on ordinary ASCII input, only on the specific Unicode-lookalike bypass this closes.
