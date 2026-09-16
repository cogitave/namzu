---
"@namzu/sandbox": patch
---

A failed Kubernetes lease renewal now retries on a short capped backoff — one second, doubling, capped at whichever is smaller of thirty seconds or a twentieth of the TTL — instead of waiting a full half-TTL for the next attempt.

`KubernetesLeaseRenewal.tick()` used to schedule its next attempt a full jittered half-TTL after every outcome, success or failure alike. A renewal failure landed its retry 0.9–1.1 × TTL after the last success, while the object's `shutdownTime` was exactly one TTL after that same success: a single API blip at renewal time expired a live claim with roughly 50% probability, and the controller deleted the pod out from under whatever command was still running in it. The fix does not change what a success does — the loop still renews every half-TTL and reports nothing — only how quickly it comes back after a failure, so a short outage around a scheduled renewal now gets several attempts inside the window that actually matters instead of one. A renewal that finds the object already gone (404/410) still stops the loop immediately, exactly as before.

No public API changed — `LeaseRenewalOptions` gained no new field, and no default a caller configures moved. This is a bug fix to already-documented behaviour (`onLeaseRenewalError`'s doc comment and the [lease renewal](docs/sdk/kubernetes-sandbox.md#the-lease) page both promised the resilience this now actually provides), so it ships as `patch`.
