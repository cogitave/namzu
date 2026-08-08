---
'@namzu/cli': minor
---

**A provider namzu cannot build is no longer offered as if it could.** Three
registry entries advertised providers whose driver packages are not
dependencies of the CLI. Two of them are genuinely discovered — one by a local
probe, one by an ambient `AWS_ACCESS_KEY_ID` — so the picker listed them,
choosing one saved it, and the next session refused it on a screen with a
disabled composer where the advice "pick another" cannot be followed.

`ProviderRegistryEntry` gains **`constructible`**: whether this build of the
CLI bundles a driver for the entry. It is a statement about the CLI's
dependencies, not about the provider. Four consumers read the registry as truth
and only `constructProvider` knew better; now they all read the same answer.

What changes for an operator:

- **The picker** still lists a discovered-but-unbuildable provider, marked
  `unavailable in this build`, and refuses to accept it with a message naming
  the providers that do work. Hiding the row was rejected: someone whose only
  local server is one of these would see "No providers detected", which is
  false.
- **A saved primary** naming one is refused when preferences are read, which
  routes to the picker with the reason. This is the fix — refusing later, at
  construction, is what produced the dead end.
- **`writePreferences`** refuses to save one as a primary.
- **A fallback** naming one is unchanged: dropped from the chain at launch with
  a notice, session runs. Refusing the whole file over a spare would take away
  a working primary.

No dependencies were added. Bundling the three drivers is a supply-chain
decision with a real cost — one pulls a large cloud SDK into every install —
and it belongs to the owner. This change makes the entries stop lying either
way; wiring any of them later is a one-line flag flip plus a switch arm, held
in agreement by a test. Closes #257.

**Also closes #258**, which is the same question from the other side: whether a
local provider whose server is not running should be listed. It should not, and
the reason is that membership in the discovery list means "usable right now" —
the `providers.chain` doctor check reads presence itself as the verdict for a
provider that needs no key, and the chain builder applies no credential test to
one, so an entry for a down server would make both of them wrong. The dead branch proposing it is
removed; the operator-facing half it wanted already exists in the picker's
empty state, which names both local servers and their ports. The discovery
header also now lists all three questions it claimed to ask — it named two, and
the missing one was the Keychain read — and states that the Keychain path is
macOS-only, which is a gap on every other platform rather than a nuance.
