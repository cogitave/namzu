---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Expose optional `recordedAt` Unix milliseconds on evidence search matches, exact read pages and recall candidates. CLI conversation search/read and automatic recall preserve the stored event time, including each included occurrence of equal text. Callers can distinguish recording times without inferring them from run IDs, file times or run-start metadata.

Unknown or invalid stored timestamps stay absent; custom recall callbacks must omit unknown times and supply positive integer milliseconds within the JavaScript Date range when known. The timestamp dates recording, not fact validity; compaction copies carry their own copy time. Sequence still orders one run, and clocks across runs do not establish causal order. Existing retrieval ordering, scope, read limits and source validation remain unchanged.
