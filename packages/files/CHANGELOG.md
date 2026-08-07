# @namzu/files

## 0.2.1

### Patch Changes

- 48d9d67: Published tarballs no longer contain test files.

  `files: ["dist", "src", ...]` reads as "the build output and the sources" and
  means "everything the compiler emitted and everything in the tree", so every
  compiled test, its declaration, and both source maps shipped to the registry —
  and for the twelve packages that also ship `src`, the raw test sources went with
  them.

  Measured on the versions currently published:

  | package      | files       | of which tests | unpacked           |
  | ------------ | ----------- | -------------- | ------------------ |
  | `@namzu/sdk` | 3879 → 2239 | 1640 (42%)     | 12.73 MB → 6.81 MB |
  | `@namzu/cli` | 462 → 282   | 180 (39%)      | 1.21 MB → 0.73 MB  |

  Nothing you can import changes. Every package restricts `exports` to `"."`, so
  Node refused a deep subpath into those files already — they were weight in the
  tarball and nothing else. Hence `patch`: there is no consumer-visible surface
  here, only less to download.

  The exclusions are at the packaging layer, not the compiler. Adding `exclude`
  to `tsconfig.json` would have kept tests out of `dist` and also dropped them
  from `tsc --noEmit`, silently ending type-checking of the entire test suite —
  trading a packaging defect for a much worse one.

## 0.2.0

### Minor Changes

- 935b8f3: Three public identifiers named a vendor where the code was generic. Renamed,
  and in two cases the naming was hiding a design problem worth fixing.

  **`OpenRouterEmbeddingProvider` → `HttpEmbeddingProvider`** (config type
  likewise). Nothing about the class was vendor-specific: it POSTs to
  `{baseUrl}/embeddings` with a bearer key and reads back
  `{ data: [{ index, embedding }] }` — the shape every hosted embeddings
  service speaks. Only the name and a default host said otherwise.

  `baseUrl` is now **required**. It defaulted to one vendor's host, which
  meant a caller who never named an endpoint still shipped its text to one. A
  default network destination is a decision the caller has to make out loud.
  A trailing slash is now tolerated rather than producing a doubled path.

  **`AgentFactoryOptions.provider`** was `'openrouter' | 'bedrock'` — a closed
  two-member union in a generic factory, naming two specific services that the
  provider registry has never been limited to and that no caller could extend.
  It is now `string`: any registered provider type.

  **`AgentFactoryOptions.bedrockConfig`** is replaced by
  `providerConfig?: Record<string, unknown>`, passed through untouched. The
  old field existed for exactly one service and had no construction site
  anywhere in the workspace.

  **`StorageProviderId`**: the `'anthropic-files'` member is now
  `'provider-files'`.

### Patch Changes

- 935b8f3: Close every open code-scanning finding

  **Breaking:** `LocalExecutionContext.executeCommand` no longer interprets its arguments as shell syntax. `shell` defaulted to `true`, and spawning with a shell re-joins the command and its argument array into a single `sh -c` string — so every metacharacter inside an argument became syntax. An `args` array reads argv-safe and was not. The default is now `false`; `shell: true` remains available where a caller genuinely wants a pipeline. A consumer passing `"ls -la"` as one command string, or relying on glob expansion without asking for a shell, must now pass `shell: true`.

  **A sandbox timeout is bounded, and an out-of-range one is refused.** The bash tool's `timeout` argument is a number the model writes, with no ceiling of its own, and it reached both sandbox transports unmodified — so a single call could pin a container or a guest for as long as the platform's timer honours. Both transports now refuse a non-finite, non-positive or over-thirty-minute request rather than clamping it: running under a deadline the caller never chose, and never learns about, is the "accepted and silently not applied" failure this codebase treats as worse than not offering the control at all.

  **Seven quadratic-backtracking regexes are now linear scans**, each on a path an attacker can reach: shell output the agent captured, a tenant-supplied connector URL, a host-supplied workspace root, a model completion, and three endpoint strings that cross the same trust boundary. The worst measured over thirty seconds on a single pathological input, on a shared event loop. Three of the seven were not flagged by the scanner — the same pattern, the same boundary — and were fixed with the rest rather than left to be rediscovered.
