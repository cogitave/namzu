---
'@namzu/sdk': minor
'@namzu/anthropic': patch
'@namzu/openai': patch
---

A message can carry a reference to an attachment instead of its bytes.

Every attachment was inline base64 on the message. That is fine for one screenshot and wrong for everything it implies: the bytes are copied into the run's durable transcript, into every checkpoint, into every compaction pass that walks the history, and — because a conversation resends its history — into every subsequent request. A 4 MB PDF attached once is 4 MB in the transcript and 4 MB on the wire per turn for the rest of the run.

New: `StoredAttachmentRef` as a third member of `MessageAttachment`, the `AttachmentStore` seam, and `attachmentStore` on `query`. The kernel treats `ref` as **opaque** — this seam says nothing about whether it is a hash, a path or a URL, because the store that minted it is the only thing that can answer. A content-addressed store gets deduplication for free; this interface neither requires nor prevents that.

Resolution happens once, where the run is seeded, before the messages reach the run record. Resolving at the provider boundary instead would put refs in the durable transcript, and a run resumed against a store that had since forgotten a ref would fail replaying its own history rather than at the moment somebody asked for the bytes.

**Every failure refuses**, and none of the three returns the message unchanged: no store, no such ref, and bytes whose media type is not what the message declared. A message that quietly lost its image is a model answering about a picture it never saw, confidently, with nothing in the transcript saying why. One unresolvable ref refuses the whole conversation rather than resolving what it can.

Both provider drivers refuse an unresolved stored attachment rather than sending `data: undefined`. The OpenAI driver reads the real SDK type and the compiler caught it; the Anthropic driver reads through a structural cast and did not, so the stored member is spelled out in its local type — that difference is written at the site.
