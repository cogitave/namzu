---
'@namzu/sdk': patch
---

Preserve readable evidence in compaction verifier requests. Rich tool-result text no longer becomes `[object Object]`, and tool-only assistant turns retain their call IDs, names and arguments alongside result error flags. Image and document attachments are represented by descriptors without their payloads or provider-private reasoning state. The excerpt character budget now includes labels, separators and the truncation marker, including when arguments or attachment names are large.
