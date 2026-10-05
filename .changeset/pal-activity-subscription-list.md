---
"@namzu/sdk": minor
---

`DiskPalActivitySubscriptionStore.list()` is an additive trusted-host read of frozen latest subscription records, including disabled subscriptions. A missing root returns an empty list, while malformed or unreadable committed records and aliased directories reject the complete projection. Hosts must still enforce tenant and participant access before exposing metadata.

Custom `PalActivitySubscriptionStore` implementations do not acquire a new required method, and existing create, get, consent and progress behavior is unchanged.
