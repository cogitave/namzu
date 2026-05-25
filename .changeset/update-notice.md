---
'@namzu/cli': minor
---

**namzu tells you when an update is available — for itself and for clawtool.**

On launch, namzu does a best-effort check for newer versions of `@namzu/cli` (npm) and clawtool (`clawtool upgrade --check`, with a fallback for older clawtool binaries) and, if either is behind, surfaces a single notice with how to upgrade — e.g. `clawtool 0.22.159 → 0.22.160 (clawtool upgrade)`. Offline / unpublished / no-clawtool is a silent no-op.
