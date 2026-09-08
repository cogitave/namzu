---
"@namzu/sdk": minor
---

Add optional structuredOutput.review to check parsed structured results before publication. Rejections supply correction feedback, bounded by maxReviews (default three). Reviewer failures fail the run and cancellation stops waiting. Checkpoints retain consumed correction opportunities; hosts must supply their review configuration when resuming. Existing callers without a reviewer keep their current behavior.
