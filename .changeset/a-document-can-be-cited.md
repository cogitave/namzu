---
'@namzu/sdk': minor
'@namzu/anthropic': minor
---

An answer can cite the document it came from

Sending a document buys the provider's native handling of it — page structure, built-in OCR, and the ability to say which passage an answer rests on. namzu could send the document and could not receive the third: an answer about a contract arrived as prose, and checking it meant reading the contract again by hand. A citation is the difference between an answer you trust and one you verify.

`citations: true` on a document attachment asks for them; they come back on the assistant message as `Citation[]`. Opt-in per document, because the provider splits the document into citable units and the answer carries the passages it leaned on — tokens a turn that never wanted a citation should not pay.

The location is a union — `page`, `char` or `block` — rather than a page number, because providers segment differently and the segmentation is theirs. Flattening all three would invent a page number for the two that have none. Web-search and search-result citations are deliberately dropped: they point at something that was never in the request, so there is no attachment to resolve them against, and a citation the reader cannot go and look at is worse than none.

Citations ride with the turn that made them, like reasoning blocks, so compaction takes a turn's evidence with it rather than leaving citations pointing at prose that is gone.
