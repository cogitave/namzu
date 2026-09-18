# @namzu/google

## 0.3.1

### Patch Changes

- 8d5223b: Nothing a consumer installs or calls changes, and that is the whole of this
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

## 0.3.0

### Minor Changes

- 64d9b9b: CLI auto search now selects native live search for supported direct Anthropic and Google API-key models instead of Exa. Native requests use provider quotas and execute without local tool approval. Set `web.backend: exa` to keep the previous common-search behavior on these routes. Unsupported model/endpoint combinations retain common search under auto; cached mode is never silently changed to live.

  Add model/mode-aware hosted-search capability checks, preserve them through provider wrappers, and forward hosted search through ReactiveAgent and delegated runs. Anthropic retains encrypted search blocks and citation indices for unchanged matching-route continuation; Google retains grounding source links. Common search previews omit internal provenance framing while preserving raw results for the model and history.

## 0.2.0

### Minor Changes

- 7785cb4: Add Google model access with a native SDK provider and CLI model selection. Reuse an existing Gemini CLI Google sign-in from this device, including the paired Windows home under WSL, without requiring a new API key. Explicit Gemini or Google API keys remain an alternative and take precedence when configured. Borrowed sign-ins are refreshed in memory without rewriting their owner file; Google account access retains the Code Assist route rather than being sent to the API-key endpoint.

Initial native Gemini API and existing Gemini CLI OAuth transport.
