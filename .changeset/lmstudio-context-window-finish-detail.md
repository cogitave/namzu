---
'@namzu/lmstudio': patch
---

A response `contextLengthReached` cut off, after it had produced content, now carries `finishDetail: 'context_window'` alongside `finishReason: 'length'`. It used to report a plain `'length'` finish, indistinguishable from `maxPredictedTokensReached`, so the runtime auto-continued it — sending a reply that had just filled the model's context window straight back in, in a prompt now longer than the window it had just overflowed. `maxPredictedTokensReached` is unchanged: still a plain `'length'` finish, since the output-token budget (not the conversation's length) is what ran out, and the runtime's ordinary auto-continue is right for it.

`contextLengthReached` with no content is unaffected: `chatStream` still fails that turn with a `context_overflow` error before any finish reason is reported.
