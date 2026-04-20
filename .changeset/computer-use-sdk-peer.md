---
"@namzu/computer-use": minor
---

Move `@namzu/sdk` from `dependencies` to `peerDependencies`.

Previously, `@namzu/computer-use@0.1.0` declared `@namzu/sdk` as a direct runtime dependency (`workspace:^`), which meant a consumer installing both packages would end up with **two concurrent copies of `@namzu/sdk`** in `node_modules` — the one they installed themselves and the one computer-use resolved. This produces symbol-identity bugs (two separate `AgentManager` classes, two separate `RunEvent` schemas, etc.) that surface as hard-to-diagnose "instanceof fails" at runtime.

The correct shape, matching the 7 provider packages, is peer + dev:

- `peerDependencies`: `@namzu/sdk: ">=0.1.6 <1.0.0"` — consumer provides, resolved once.
- `devDependencies`: `@namzu/sdk: workspace:^` — for local dev and type-checking.

**Consumer migration:** if you previously relied on `@namzu/computer-use` pulling `@namzu/sdk` in transitively, install it explicitly:

```
npm install @namzu/sdk @namzu/computer-use
```

This is technically a breaking change (the transitive resolution no longer works), but pre-1.0 SDK context and the runtime-corruption risk of the old shape justify correcting it as a minor bump.
