---
'@namzu/anthropic': minor
'@namzu/openai': minor
---

Documents and citations were designed in the SDK and never built in the drivers.

`DocumentAttachment` and `Citation` existed in `@namzu/sdk` with a page of documentation about why native document handling is worth having — page structure, the provider's own extraction, and the ability to say which passage an answer rests on. The stream chunk carried a citation slot, the run's stream aggregator collected them onto the assistant message, and the iteration attached them to the turn. Both these drivers declared `supportsDocuments: true`.

Neither had a document branch. Every attachment was mapped as an image — a PDF went up as an image block with `media_type: application/pdf` on one wire and as `data:application/pdf;base64,…` inside an `image_url` part on the other, shapes the APIs reject. And only the mock provider ever emitted a citation, so in a real run the slot was always empty: an answer about a contract arrived as prose, and checking it meant reading the contract again.

- **`@namzu/anthropic`** now sends a native document block carrying the media type, the optional title, and — only when the attachment asked for them, because they cost tokens — citations. It parses citation deltas back onto the stream, keeping the location as the discriminated union the SDK defines: a provider that segments by character offset has no page number, and a citation whose location cannot be named is dropped rather than given an invented one. A citation that looks checkable and is not is worse than none.
- **`@namzu/openai`** now sends a document as a `file` content part with its filename. That wire has no way to return citations, so a document that asks for them is refused with a message naming the document and what to do instead — answering without them would drop the checkability the caller asked for, and an empty citation list reads as "the model cited nothing" rather than "nobody asked".

The drivers that declare `supportsDocuments: false` were already honest: none of them map attachments at all, and the runtime warns (or fails under `strictCapabilities`) before the request is built.
