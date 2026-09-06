---
"@namzu/sdk": major
"@namzu/cli": major
---

Make builtin `grep` enumerate files incrementally instead of listing an entire directory tree before searching. It stops at 20,000 examined entries and has a 15-second tool deadline, replacing the previous 120-second deadline. Narrow the search directory or include pattern when these bounds are reached. The default result limit remains 100; reaching it now explicitly reports an incomplete search rather than claiming that every file was searched. Partial matches and traversal errors remain visible.

Custom sandbox adapters must implement `Sandbox.walkFiles` for content search; `grep` refuses adapters that only provide eager `listFiles`, without falling back to the host filesystem. Existing recursive include semantics and the 5 MiB per-file limit remain in place. Oversized files are skipped before reading when size metadata is available, and cancellation stops consuming pending reads.
