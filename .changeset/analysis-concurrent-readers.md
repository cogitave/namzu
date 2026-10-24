---
"@namzu/analysis": patch
---

Fix `findLiteral` and `findCallers` failing with "file N is not in the index" while another process was indexing the same root into the same cache. Every indexer replaced the rows of files that another indexer had just stored from identical bytes, which re-issued their ids under any reader in the middle of a query, and a reader that lost the race five times in a row gave up. An indexer now keeps rows that already match the file it parsed, and these queries read their hits and the files behind them from one consistent view of the cache. No API change; nothing to do on upgrade.
