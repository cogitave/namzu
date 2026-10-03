---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add optional provider-owned Pal computer takeover through `PalComputerControl`,
`PalComputerInput` and runtime control methods. Hosts can transfer an idle guest
to human input using its exact generation, return it without waking the Pal, and
observe current control authority. Providers without the optional port retain
normal Pal execution and explicitly refuse takeover.

The runtime serializes control operations, refuses new Pal admissions during
operator control, and requires each subsequent admission to obtain its own
fresh screenshot before GUI input. CLI desktop ACP exposes take-over, return and
bounded input methods; optional screen generation pinning rejects stale captures.
