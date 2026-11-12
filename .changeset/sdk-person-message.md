---
'@namzu/sdk': minor
---

Peer messaging can carry the operator's own words from another terminal. New: the `person` sender kind (`PeerSessionKind`), `formatPersonMessage` (a frame that says the person spoke, not another agent, and that it is not an approval, with the text quoted under a per-render nonce), the `person-message` runtime-context kind, an optional `conversation` on `deliver` so a host that moved to another conversation can refuse, and a `delivered` value for a delivery notice's `outcome` (`NoticeOutcomeSchema`). `formatPeerMessage` renders a `person` sender through `formatPersonMessage`. A build that predates `person-message` reads such a recorded message as an ordinary user message whose text still carries the kernel's paragraph; a host with its own exhaustive switch over `RuntimeContextMessageKind` or `PeerSessionKind` needs a case for the new members.
