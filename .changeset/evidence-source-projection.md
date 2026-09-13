---
'@namzu/sdk': minor
'@namzu/cli': minor
---

Expose `classifyEvidenceSource`, `EvidenceRecordKind` and `EVIDENCE_RECORD_GUIDANCE` for hosts presenting authenticated text evidence. Automatic recall uses the same classification. The helper interprets source tags only; it does not authenticate text or establish that its claims are true.

CLI `search_conversation` matches and located `read_conversation` pages now include `recordKind` with interpretation guidance. Exact reads also preserve recorded `toolName` and `isError`, leaving missing status unknown. Tool names exceeding 256 JSON-encoded UTF-8 bytes are omitted consistently. Original text, addresses, scope checks and pagination remain unchanged.
