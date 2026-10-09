---
"@namzu/cli": minor
---

The desktop host's `namzu/pals/communication/inbox` answer now carries `receivedAt` (epoch milliseconds, when the Pal's inbox accepted the input) on every row, and, for a message the owner sent from their own conversation (`sourceKind: operator-conversation`), the message `text` (up to 4,000 characters) so the owner can read back what they approved. Messages from Pals and channels still carry no text, and the existing fields are unchanged. Nothing breaks: a client that ignores unknown fields keeps working, and a strict one that compared whole rows must allow the two new keys.
