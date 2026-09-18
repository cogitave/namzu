---
"@namzu/ag-ui": patch
"@namzu/anthropic": patch
"@namzu/bedrock": patch
"@namzu/cli": patch
"@namzu/computer-use": patch
"@namzu/deepseek": patch
"@namzu/files": patch
"@namzu/google": patch
"@namzu/http": patch
"@namzu/live": patch
"@namzu/lmstudio": patch
"@namzu/lsp": patch
"@namzu/ollama": patch
"@namzu/openai": patch
"@namzu/openrouter": patch
"@namzu/sandbox": patch
"@namzu/sdk": patch
"@namzu/telemetry": patch
"@namzu/zen": patch
---

Nothing a consumer installs or calls changes, and that is the whole of this
release. `vitest` moves from `^3.2.6` to `^4.1.11` in the `devDependencies` of
all nineteen packages that declared it, and `@vitest/coverage-v8` moves with it
in `@namzu/sdk`. Every occurrence is a devDependency — checked, not assumed —
so `dependencies`, `peerDependencies`, exports, types, defaults and the wire
shape are untouched, and the published tarballs differ from the previous
release only in `package.json#devDependencies`.

The reason is a security fix with no 3.x backport. `GHSA-82fw-gwwq-j7x9`
("Path Traversal / Arbitrary File Read via `@vitest/mocker` Redirect Mock")
covers `vitest` and `@vitest/mocker` from `2.1.0` up to `4.1.11`, so `^3.2.6`
can only be resolved by leaving the 3.x line. `4.1.11` is the first patched
release and is what the lockfile now resolves for both.

What this costs anyone who works on the repository rather than with it: the
upgrade was not a version bump. Vitest 4 changed test discovery, coverage
configuration, mock construction and reporter output, and each of those broke
something here that had to be migrated rather than worked around. Those fixes
are all under `__tests__/`, `vitest.config.ts` files and `scripts/`, none of
which is published, which is why this is a patch and not a major.

You do not need to do anything. If you pin `vitest` yourself to run this
project's own suites, note that the config files it ships are now written for
`>= 4.1.11` and will not run under 3.x.
