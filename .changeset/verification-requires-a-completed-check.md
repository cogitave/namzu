---
"@namzu/sdk": major
---

Command-backed answer verification rejects interrupted commands even if their
termination handler exits zero, and converts executor failures into rejection
feedback. Fingerprint exceptions mean unknown state rather than a throwing
reviewer; interrupted checks may retry without a source change. Run cancellation
is available as `AnswerReviewContext.signal` and reaches built-in verification
commands without being replaced by answer rejection.

The workspace change detector includes the Git commit, so different clean commits
do not suppress verification as unchanged. Interrupted Git commands produce unknown
state even if they exit zero. Unchanged feedback describes the detector's actual
scope instead of claiming no file or external input could have changed.

`maxOutputChars` must now be a nonnegative safe integer; invalid values previously
reached JavaScript slicing behavior. Use zero to suppress diagnostic content or
an integer character allowance. The omission marker now counts inside that
allowance, so clipped excerpts may retain fewer source characters than before.
Other review-path limitations, including generic callback exceptions and separate
forced/terminal completion paths, remain documented in Answer verification.
