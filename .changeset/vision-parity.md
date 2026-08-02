---
'@namzu/bedrock': minor
'@namzu/http': minor
'@namzu/openrouter': minor
---

Every driver can now see.

These three dropped `attachments` outright, so a user who attached a
screenshot got a turn about nothing. `supportsVision: false` said so, which
made the declaration honest and the driver useless — and it was the last
place in the estate where a namzu capability existed on one driver and
silently did not on another.

Each wire carries an image differently, so this is one intent and three
mappings:

- **Converse**: raw bytes in an image content block beside the text. The
  tool-result path already did this; the user path never looked at
  `attachments`.
- **The two-dialect HTTP driver**: a `data:` URI content part on one
  dialect, a base64 source block on the other.
- **The gateway driver**: a `data:` URI content part.

Across all three: a media type the endpoint cannot decode is named in the
text rather than sent, because a payload it rejects fails the whole request
and losing the turn is worse than losing sight of one image. A message with
no attachments keeps its plain-string content, so nothing about an ordinary
request changes shape. Several attachments on one message are carried in
order.

An image inside a **tool result** still degrades to a text placeholder on
the HTTP and gateway drivers: a tool message is text-only in those dialects,
so there is nowhere to put it. Converse carries it, and always did.
