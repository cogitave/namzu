---
'@namzu/cli': patch
---

The TUI's local `exceptionAttributes` helper (`packages/cli/src/tui/agent.ts`) is now typed to return `LogAttributes` instead of a bare `Record<string, string>`. The two keys it has always produced (`exception.type`, `exception.message`) already match the namespace pattern, so this is a type-level narrowing with no behavior change — it exists so `scripts/check-log-standard.mjs`'s new namespaced-attribute-key rule can prove the call sites that pass this helper's result to a `Logger` are compliant by type, rather than leaving them as three more entries in that rule's ratchet count.

No public API change: `exceptionAttributes` is a module-private function, never exported.
