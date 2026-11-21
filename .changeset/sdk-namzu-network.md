---
'@namzu/sdk': minor
---

Adds your Namzu network: the pieces a host needs for machines of one person to find each other on a private network, join with one Allow, show one roster of sessions, pass roles, and exchange messages under the local safety rules. It is new, `@experimental` and used only if you call it: `createNamzuNetwork`, `createMdnsDiscovery`, `decideMail`, `evaluateMembership`, the roster helpers and `formatRoleContext`. Nothing in an existing host changes until it adopts it.

Additive changes to what already existed, which an exhaustive `switch` over these unions will notice: `PeerSessionKind` has `'net'`, `NoticeOutcome` has `'expired'`, `DeliverRequest` has an optional `remote`, `PeerRecord` has optional `role`, `roleBy` and `roleAt`, `formatPeerMessage` takes an optional `machine`, and `SystemEventKind` / `SystemEventStatus` have `'role-notice'` and `'expired'`. An endpoint accepts `remote` only from a verified `net` sender and refuses a `net` sender that omits it; no existing sender is affected. The network listens only on private addresses, never for an unattended host, and writes nothing under `~/.namzu/network` until a host starts it.
