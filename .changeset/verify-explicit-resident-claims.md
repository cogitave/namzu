---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add `createJsonClaimVerifier` for host-configured scalar JSON claims and observation-time receipts. It rejects mismatched, incomplete, historical or foreign observations, bounds verification time and bytes, and exposes pending observation drainage. Hosts supply an authorized read adapter; this does not verify arbitrary prose or establish atomic/future source state.

Resident `run` and `start` accept `--verify <manifest>` to require configured claims before recording completion. The manifest explicitly authorizes bounded host file reads, is snapshotted per invocation, and applies to every admitted pursuit. Rejected values use the existing repair budget; only the reviewed answer can complete. Existing invocation behavior is unchanged without the flag.
