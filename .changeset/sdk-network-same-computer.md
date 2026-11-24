---
"@namzu/sdk": minor
---

A Namzu network member can admit another home of the same person on the same computer without an Allow. `createNamzuNetwork` takes the new options `machineSecret` (where this home's computer secret is; omit it and the home asks as before), `sameComputer` and `hardenDirectory`. A joiner holding the secret sends an optional `computerProof` in `join_request`; the member checks it and emits `join-auto` with the new `mode: 'same-computer'`, so code that switches on `mode` should handle a third value. `RosterMachineView.sameComputer` and the `same_computer_unavailable` and `same_computer_mismatch` audit events are new. New exports: `resolveComputerSecret`, `readComputerSecret`, `ensureComputerSecret`, `homeQualifies`, `COMPUTER_SECRET_FILE`. The member also returns `computerMemberProof` in the `admitted` frame and the joiner marks a member only when it verifies. Nothing changes for a host that passes no `machineSecret`.
