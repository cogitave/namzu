---
"@namzu/sdk": patch
---

A model request that the operator cancelled on purpose (a cancel with the `user` cause, such as stopping a child or skipping a workflow agent), before the provider reported any usage, is now closed on an estimate (the prompt plus the text that had streamed) instead of being left as unknown spend. Before, stopping or skipping one delegated child under a finite token budget marked the whole budget unusable, and every sibling and every later child was refused with "0 tokens remaining". A request that fails for any other reason, or whose tree was torn down by a parent or a closing runtime, keeps its unknown-spend marker. The estimate can undercount what the provider billed for the part it never reported.
