# @namzu/live

## 1.0.2

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

## 1.0.1

### Patch Changes

- 47e573c: Validate the Namzu live adapter with factory-generated project, session, topic and tenant IDs. Its real-query regression fixtures now satisfy the SDK's durable path validation without bypassing the query configuration types.

## 1.0.0

### Minor Changes

- 4c5728f: Add the independent `@namzu/live` runtime with live agents and sessions,
  pluggable VAD/STT/turn-detection/TTS/audio-output drivers, continuous bounded
  audio ingress, barge-in cancellation, and a `NamzuModel` bridge that keeps SDK
  tools, policy, run stores and telemetry authoritative. Public turn/listening
  handles are created and tracked by their session, and independent speech
  drivers correlate final transcripts to VAD intervals by their shared source
  timestamp instead of callback order. The initial package supports
  `@namzu/sdk` versions from 33.1.1 through the 33.x line.

### Patch Changes

- ad1bab9: Document the supported SDK range, process-local history, custom-model
  ownership, driver lifecycle and session-tracked turn and listening handles.
- Updated dependencies [ad1bab9]
- Updated dependencies [7347b8d]
- Updated dependencies [4c31053]
  - @namzu/sdk@34.0.0

All notable changes to this package are documented through repository Changesets.
