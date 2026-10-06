---
"@namzu/sdk": patch
---

Fail structured tool output explicitly when its retained receipt is no longer valid JSON, including without a reviewer, instead of publishing truncated or rewritten text as a successful structured result. Increase `maxToolOutputChars` for larger tool results or select native structured output with a capable provider.

Make `wait_for_task` report the underlying turn outcome and retain failure explanations even with an empty answer. Completed scheduler lifecycles containing failed, partial or cancelled turns no longer appear successful; legacy completed results without a turn status retain their existing behavior. Blocking `create_task` and linked planning failure notes also preserve those explanations and describe empty legacy completions accurately.

Report a planning-task status change that cannot be confirmed as failure with the requested and returned statuses. The store may have refused the request or a concurrent update may have advanced it; other requested edits may already have applied. Existing store transition policies remain unchanged; successful task updates retain their quiet presentation.
