---
'@namzu/sandbox': minor
---

Add optional configured-profile validation to existing-volume inspection, closure volume opening and exact live-guest reopening. Validate the template, runtime class and egress profile on the owner read before mutation or guest access. Retiring agent refusals retain their fresh boot identity; exact bound cleanup accepts only the original boot and reports an unavailable flush. Older agents that omit retirement identity remain refused. Rebuild the guest image for retirement recovery, and retain the same bound transition through ambiguous stop acknowledgement.
