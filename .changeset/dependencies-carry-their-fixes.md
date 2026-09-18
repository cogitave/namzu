---
"@namzu/sdk": patch
---

Nothing a consumer installs changes. These are devDependencies and toolchain
pins: no runtime dependency, export, type or default moved, and the published
surface is identical.

Four advisories, all dev-time, closed by moving the package that carried them
rather than by patching around them:

- `knip` `^6.4.1` → `^6.37.0`, which carries `smol-toml` ≥ 1.8.0 — the version
  that fixes `GHSA-7w5x-hrqm-74c2` (a malformed-TOML denial of service).
- `tsx` `^4.19.0` → `^4.23.13`, which depends on `esbuild ~0.28.0`, fixing
  `GHSA-g7r4-m6w7-qqqr` (arbitrary file read from the development server, and
  only on Windows) — and collapsing two `esbuild` copies in the tree into one.
- `js-yaml`, twice, fixed by a workspace override rather than a parent upgrade,
  because both copies arrive deep inside the Changesets CLI's own tree:
  `^3.15.2` for the 3.x line and `^4.3.2` for the 4.x line, closing
  `GHSA-2883-xcg3-v3hh` (a merge-key CPU exhaustion). Neither override widens
  beyond what the parent already declared — `3.15.2` satisfies `^3.13.1` and
  `4.3.2` satisfies `^4.1.0` — so no package is forced outside its range.
