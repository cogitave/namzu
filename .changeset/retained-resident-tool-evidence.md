---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Residents can search and page original retained tool text from earlier settled invocations, even when the latest summary or compacted context omits it. The SDK adds bounded disk indexing, scoped source interfaces and `search_resident_tools` / `read_resident_tool` builders. The CLI binds them to the admitted pursuit, matching attempt receipts and invocation ownership; ordinary conversations gain no cross-session access.

Fix fresh disk-backed runs capturing their output directory before store initialization, which could leave oversized tool output as an unrecoverable preview. New spills record chunk integrity manifests, and new run metadata records its own tenant/project/Session/run scope independently of shared token accounting. The existing 40,000-character model-visible cap remains unchanged. Older unscoped runs are unavailable through this API; older truncated records without authenticated spills remain explicitly partial. Missing or modified output is never replayed or presented as an intact original.
