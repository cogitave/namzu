---
'@namzu/sandbox': major
---

The standby-pool backend refuses to claim a container group on a public address

Omitting `subnetId` meant the platform assigned a public address, and the backend claimed the group and dialled it without comment. The worker answering there has no authentication of any kind — `worker/server.js` states "Authn: none" in its own docblock — so an unauthenticated execute endpoint was reachable from the internet, chosen by a caller who had never heard of a field.

The backend now refuses that combination. Two ways forward, and the error names both:

- **`subnetId`** — inject the group into a private network. This is the production answer, and the file already recommended it.
- **`allowPublicAddress: true`** — a new option, off by default, for a benchmark where you mean it.

**This is `major` and it will stop a deployment that works today.** If you run this backend with no `subnetId`, the next claim throws instead of succeeding. That is deliberate: the alternative is a warning on a path that otherwise succeeds, which is read once and never again.

The trust-model docblock used to end "Caller decides". Nothing asked them — omitting a field chose the public address silently, which is not a decision. That sentence has been corrected rather than deleted, so a reader who saw the old one learns what changed.
