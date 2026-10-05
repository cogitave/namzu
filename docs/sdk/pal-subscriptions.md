---
type: Reference
title: Durable Pal activity subscriptions
description: Current observation, disclosure and receipt consent, original-journal causality and durable progress over the common Pal inbox.
resource: packages/sdk/src/pals/activity
tags: [sdk, pals, activity, subscriptions, consent]
status: stable
generated: { by: process:codex, at: "2026-10-02" }
---

# Durable Pal activity subscriptions

`DiskPalActivitySubscriptionStore` saves a host-owned subscription from one
immutable `PalActivityScope` to one `PalAddress`. `create`, `get`, `setEnabled`
and `advance` use private revision records. `revision` changes with progress or
configuration; `configurationRevision` changes only with enable/disable.
Scope and destination cannot be retargeted. `setEnabled` requires
`expectedRevision`; conflicting updates raise `PalActivitySubscriptionConflictError`.
`advance` requires the captured subscription and an unchanged cursor emitted by
the trusted original-journal source. It rejects concurrent changes and backward
progress. Never supply a remote client's cursor or model-selected offset.

The concrete disk store also provides `list()` for trusted host metadata
projections. It returns frozen, validated latest records, including disabled
subscriptions, and an empty list if the root is absent. Empty allocations from
an earlier missing `get` contain no subscription. A malformed or unreadable
committed record or aliased directory rejects the whole list; it never returns
a partial list that a client could mistake for deletion. Hosts must separately
filter tenant and participant ownership and redact storage errors before exposing
the result. `list()` is additive on `DiskPalActivitySubscriptionStore`; custom
`PalActivitySubscriptionStore` implementations do not need to implement it.

## Independent current permissions

`DiskPalActivitySubscriptionPolicy` provides `get`, `update`,
`authorizeSubscription` and `authorizeIngress`. An update requires
`subscriptionId`, `expectedRevision` and independent `observe`, `disclose`,
`receive`, `wake` booleans. Missing rules deny. Authorization reloads the exact
enabled subscription and current permission. Historical message grants are
audit evidence and do not override revoked consent.

`authorizeSubscription` checks the requested `observe`, `disclose` or `receive`
phase independently. Its final `accept` phase requires all three together under
current consent immediately before durable inbox acceptance. Custom host
authorizers must implement this joint acceptance check. `authorizeIngress` requires all three for observation acceptance and
delivery, and additionally wake before idle recipient dispatch. A paused source
remains observable with consent. Receiving metadata starts no computer or model.

## One bounded publication

`publishPalActivityOnce(options, subscriptionId, { signal, maxRecords,
maxReadBytes })` resolves its stored cursor internally and uses the
[original-journal reader](pal-activity.md). Required host ports are
`subscriptions`, `ingress`, `pals`, `openJournal`, `authorize` and
`resolveCausality`. Optional `now` supplies the clock. Optional `notify` is an
isolated hint: exceptions and pending promises cannot block acceptance/progress.

The runner checks current configuration and observation before reads and facts,
then separately checks disclosure and recipient consent and checks them together
with observation again at the final `accept` boundary. Revocation during a prior
authorization cannot be replaced by its earlier audit grant. It submits closed
metadata as a `host-observation` intent to the [shared input ledger](pal-ingress.md)
using the stable original fact ID as source operation ID. It includes no private
transcript or free-form payload and does not impersonate the observed Pal.
Progress follows durable acceptance or explicit feedback suppression for every
selected fact.

The result contains the updated `subscription`, accepted message IDs,
suppressed fact IDs and `complete` for the captured boundary. Partial acceptance
or failed progress commits leave the old cursor; exact retries deduplicate
accepted facts. A concurrent configuration/progress update rejects cursor
commit. Already accepted messages remain pending under current delivery consent.

```ts
import { publishPalActivityOnce } from '@namzu/sdk'
import type { PalActivitySubscriptionRunnerOptions } from '@namzu/sdk'

export function publishActivityPage(
  trustedHost: PalActivitySubscriptionRunnerOptions,
  subscriptionId: string,
  signal: AbortSignal,
) {
  return publishPalActivityOnce(trustedHost, subscriptionId, {
    signal, maxRecords: 64, maxReadBytes: 1024 * 1024,
  })
}
```

## Verified turn causality

`createPalActivityCausalityResolver({ pals, ingress, authorize, openJournal,
maxReadBytes, maxRecords })` supplies a trusted causality callback. It verifies
a bounded complete original prefix, exact owned root, original fact pointer,
turn's first provider request and recorded observation deliveries. It compares
envelopes, route ownership, IDs/digests, claims and exact receipt pointers against
verified journal bytes. Missing intake, forged or unresolved receipts, changed
ownership, denied observation and budget exhaustion reject with
`PalActivityCausalityUnavailableError`; they never imply an independent turn.
There is no spill-body port here; spilled observation evidence currently rejects.

An observation-caused fact inherits the recorded subscription trail. Publishing
appends the current subscription ID. If it already exists, publication suppresses
that fact while consuming its progress. The shared ledger bounds trails to 32
unique subscription IDs. This guards verified observation feedback paths; it
does not prove arbitrary causality through peer messages, external side effects
or unrelated channels.

An independent turn receives an empty trail only after its first provider request
proves initial intake. Earlier facts may require a later retry. Hosts must never
fabricate independence for unknown evidence. Prefix budgets control journal
resources, not model tokens; increase them explicitly for larger retained logs.

This API installs no daemon, Team membership or external transport. Hosts
schedule finite publication and separately authorize recipient dispatch.
Durability covers committed local records and process restarts, with no claim
of cross-record atomic transactions or power-loss protection.
