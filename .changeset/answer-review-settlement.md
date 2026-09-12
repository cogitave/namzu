---
"@namzu/sdk": major
"@namzu/cli": patch
---

Prose `reviewAnswer` callbacks now fail the run when they throw or return a malformed verdict. Previously a thrown error accepted the answer without review. To keep a deliberately permissive policy, catch the error in the host callback and explicitly return `{ accept: true }`; return `{ accept: false, feedback }` only when requesting a bounded correction. Rejection feedback must be a nonempty string.

`maxAnswerReviews` now rejects negative, fractional, non-finite or unsafe values. Use a nonnegative safe integer (default three corrections). Rejection counts and feedback are saved together in checkpoints, so resuming the same checkpoint preserves the remaining allowance even after history compaction. Cancellation stops waiting for a pending reviewer; external work started by the callback must still honor its signal.

The CLI inherits these SDK semantics for host-supplied reviewers. Its command gate already converts unavailable checks to bounded rejection and keeps that behavior. Forced finalization, terminal tools and structured output retain their separate settlement paths.
