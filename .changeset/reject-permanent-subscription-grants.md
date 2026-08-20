---
'@namzu/cli': patch
---

Refuse a permanently unusable subscription refresh grant before provider work instead of repeatedly retrying it and sending the expired access token. The live session caches the refusal only for the exact credential, adopts a later login or external rotation, and treats deletion from the authoritative store as logout rather than continuing with an in-memory token.
