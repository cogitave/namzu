---
'@namzu/cli': minor
---

Edit a previous user prompt on a source-preserving conversation branch with Esc
twice from an empty composer.

The prompt picker forks immediately before the selected user message, restores
its readable text and every durable attachment into the composer, and keeps the
original conversation unchanged. Editing the first prompt creates an
empty-prefix branch. Selection is compare-and-swap guarded against durable
history so a stale picker cannot branch at a different boundary.
