---
'@namzu/sdk': major
---

Make every disk-backed message-feedback update a real compare-and-set commit across concurrent processes, not only the first write.

`DiskMessageFeedbackStore` now publishes complete immutable owner-version files through exclusive hard links, lists committed values even when the best-effort legacy projection is absent or behind, reads previous single-file records forward, refuses damaged or mixed-version projection/head states, validates runtime id prefixes before callbacks, and confines run/message keys to injective filesystem segments. Distinct message ids whose previous lossy filenames collide no longer overwrite one projection.

**What breaks:** the disk feedback store now requires hard-link support and refuses unsupported filesystems instead of falling back to a racy update. Stop every process using an older SDK before opening a shared feedback root with this version; mixed-version rolling writers are unsupported. Calls that bypassed the branded types with a run or message id lacking its required prefix now reject before message validation or persistence.
