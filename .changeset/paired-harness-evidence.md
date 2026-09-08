---
'@namzu/sdk': minor
'@namzu/cli': major
---

SDK: add `compareHarnessTrials` and `reviewHarnessCandidate` for paired,
trace-attributed harness verification with fresh confirmation and explicit
regression/inconclusive decisions. These functions inspect recorded results;
they do not automatically execute or promote candidates.

CLI: `search_conversation` now scans large transcripts in bounded pages and
returns `nextCursor` for continuation. The former 2 MiB whole-file limit becomes
a 4 MiB per-record limit. Validation now covers the current page's prefix rather
than the entire run before any result is returned. Consumers relying on whole-run
validation must validate the full archive themselves. Follow `nextCursor` with
the same query, and restart searches after cursor expiry or file changes.
