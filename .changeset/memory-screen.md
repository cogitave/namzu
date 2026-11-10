---
'@namzu/sdk': minor
'@namzu/cli': minor
---

Automatic memory no longer stores what you asked for, secrets or injected text. This is a behaviour change of automatic memory only; nothing you or the model saved on purpose is touched.

`@namzu/cli`: the records a turn writes on its own now keep only a durable preference or rule from your messages (a cue such as always, never, prefer, don't, from now on, in English or Turkish; at most 240 characters; not a question and not a request to do something now). The record is titled `Session notes` with the touched file names instead of your first message. `Searched: ...` discoveries and raw tool error text are no longer stored, and any claim that looks like a secret or an injected instruction is dropped. A turn with nothing left writes no record. Records an earlier version derived that this screen would not write are archived once per memory directory, not deleted; they stop being recalled and listed. To restore one, change `status: archived` to `status: active` in its file in the memory directory; to repeat the pass, delete `.derived-screen-v1` there.

`@namzu/sdk`: additive. `createMemoryPromoter` accepts `acceptClaim(category, text)` to leave claims out (the default keeps every claim, as before), and `findSecretShape` is exported. `save_memory` and `update_memory` now refuse content holding a provider API key or token, a private key block, a JWT, a bearer token or a URL with a password; the refusal says so without repeating the text. Text that merely talks about instructions is still accepted.
