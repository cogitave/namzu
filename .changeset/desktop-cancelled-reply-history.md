---
"@namzu/cli": patch
---

Reopened ordinary Desktop conversations now keep an assistant reply you stopped
mid-answer. Previously the partial text was visible live but vanished after a
restart; it is now restored from the saved journal and shown as stopped. A stopped
reply that had no text, or that was later replaced, still adds nothing, and Pal
chat history is unchanged. The `namzu/conversations/history` result gains an
optional `stopReason: 'cancelled'` on assistant rows; existing clients that ignore
unknown fields keep working and nothing needs to change.
