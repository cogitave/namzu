# @namzu/evals

## 0.2.1

### Patch Changes

- b2c005c: Make each README an npm package page rather than the package's manual.

  `@namzu/sdk`'s README was a twenty-four-section architecture tour, 45 KB of it; the others ran to several hundred lines each. That is the right shape for a single-package repository, where the README _is_ the documentation, and the wrong one here — it duplicated a `docs/` tree that already existed, and nothing checked that the two agreed.

  Each README is now what a reader needs in the first minute: what the package is, install with its Node requirement, one working example, and links. The long-form material moved into `docs/` whole — `docs/sdk/architecture.md`, `docs/cli/reference.md`, `docs/packages/<name>.md` — where the doc gates cover it.

  Two documentation defects fell out of the move, both in `@namzu/telemetry`'s session-export example, and both had been shipping: the config field is `redactors` and takes a list, not `redactor` taking one; and `secretRedactor` is a factory that has to be called. The required `destination` field was missing from the example entirely. They surfaced because a README is gated by nothing and `docs/` is compiled against the built SDK.

  No API change.

## 0.2.0

### Minor Changes

- c685888: Adds a `security/` suite category, and its first probe: **does `state` derive
  from the PKCE verifier?**

  `npx namzu eval` over this package now runs one more suite. Nothing existing
  changes — the `kernel/` suites, their ids and their scores are untouched — so
  the upgrade is additive unless you gate on the total suite count.

  **Why the probe exists.** In authorization code + PKCE only the challenge, the
  hash of the verifier, may travel in the authorization URL. `state` travels
  there too, so a flow that sets `state = verifier` writes the verifier into the
  address bar, the browser history and any referrer, and the protection is gone
  while every part of the ceremony is still present. It is a defect
  implementations ship.

  **Why it is not caught by the obvious test.** `state !== challenge` holds for
  the broken flow — necessarily, since the challenge is the SHA-256 of the
  verifier — so the assertion a careful person writes passes while the property
  is broken. Even `state !== verifier` catches only literal reuse.

  The probe is importable at `@namzu/evals/security/oauth-state.js` and answers
  with the _name_ of the relation it found, so you can point it at your own flow:

  ```js
  import { auditAuthorizationRequest } from "@namzu/evals/security/oauth-state.js";
  const { sound, findings } = auditAuthorizationRequest({
    url,
    state,
    verifier,
  });
  ```

  It reads one captured attempt against a fixed list of derivations. A finding is
  proof of coupling; no finding is not proof of independence, and the list is
  written out in the source so the bound is visible.

## 0.1.0

### Minor Changes

- 1c426a5: the kernel behaviour suites are publishable

  `@namzu/evals` was `private: true` and carried nothing a registry needs — no
  `license`, no `repository`, no `files`, no entry point. It is a real package
  now, so you can run Namzu's own CI gate against the kernel _you_ installed:

  ```sh
  npm install --save-dev @namzu/evals @namzu/cli
  npx namzu eval --dir node_modules/@namzu/evals
  ```

  The suites run against a **scripted provider**, so nothing in them measures a
  model. That is the point — the turns are fixed, so a score that moves means the
  kernel changed its behaviour.

  `@namzu/sdk` moved from a direct dependency to a **peer** (`>=5.0.0`). A suite
  that pulled its own copy of the kernel would be scoring a kernel you are not
  shipping.

  Two things worth knowing about what ships. `files` is an explicit allowlist —
  `kernel/`, the licence, the README and the changelog, six files and 7.7 kB.
  This package's directory also accumulates `.namzu/` run state from dogfooding:
  199 transcripts, checkpoints and reports on a working machine. None of it is
  tracked by git, so a CI publish never saw it, but a publish from a developer's
  checkout could have. The allowlist is what makes that impossible rather than
  merely unlikely.

  If you are writing your own evals you do not need this package: the runner is
  `namzu eval` in `@namzu/cli` and the report types are in `@namzu/sdk`. This one
  is only the suites.

## 0.0.6

### Patch Changes

- Updated dependencies [604a56a]
- Updated dependencies [f25ebce]
- Updated dependencies [5496fb2]
- Updated dependencies [f25ebce]
- Updated dependencies [ca64062]
- Updated dependencies [61ca851]
- Updated dependencies [c8672ed]
- Updated dependencies [f25ebce]
- Updated dependencies [f25ebce]
- Updated dependencies [c6b8aa8]
  - @namzu/sdk@5.2.0

## 0.0.5

### Patch Changes

- Updated dependencies [8dbb98b]
- Updated dependencies [7ac89da]
  - @namzu/sdk@5.1.0

## 0.0.4

### Patch Changes

- Updated dependencies [1cd1094]
- Updated dependencies [19d6a0f]
- Updated dependencies [1500973]
- Updated dependencies [a2cedfd]
  - @namzu/sdk@5.0.0

## 0.0.3

### Patch Changes

- Updated dependencies [c3cb587]
- Updated dependencies [2b9d90e]
- Updated dependencies [4be54ca]
- Updated dependencies [a1f67f3]
- Updated dependencies [df07db8]
- Updated dependencies [19f390a]
  - @namzu/sdk@4.0.0

## 0.0.2

### Patch Changes

- 6bf8160: A second behaviour suite, covering what the loop does when the context runs out.

  The gate could go red but guarded one thing: the tool loop. Compaction is the mechanism most likely to be changed by someone tuning a number — a threshold, a recent-window size, a reset fraction — and the most likely to break silently when they do, because a run that compacts too eagerly still finishes. It just costs more and paraphrases away more. That is the shape a unit test does not catch and a behaviour gate does.

  Five cases across the structured pass, the sliding window, a host reducer that declines, a built-in reducer, and no compaction at all. Three scorers, each pinning an outcome rather than an internal: no tool result is left without its call (the provider rejects the next turn with a 400 otherwise), the leading system message survives, and the run settles rather than throwing.

  Verified by breaking the kernel and watching the gate. Removing compaction's protection of the system floor is caught. Removing _only_ the reducer's tool-pair safety is **not** caught, and that is correct: the dispatch refuses a reducer result that orphans a tool result, so the outcome is unchanged and there is nothing for an outcome-shaped gate to see. Removing both guards lands a broken history and the gate catches it. A behaviour gate should measure behaviour; a scorer that went looking for the internal would have reported a regression where there was none.

- Updated dependencies [635ffa9]
- Updated dependencies [6015989]
- Updated dependencies [82888c6]
  - @namzu/sdk@3.3.0

## 0.0.1

### Patch Changes

- Updated dependencies [480892a]
- Updated dependencies [05b4103]
- Updated dependencies [480892a]
- Updated dependencies [beacf2d]
- Updated dependencies [e1a5e2d]
- Updated dependencies [b807b0d]
- Updated dependencies [9d2b927]
- Updated dependencies [7370f6d]
- Updated dependencies [ea2148c]
- Updated dependencies [480892a]
- Updated dependencies [9bbb8be]
- Updated dependencies [480892a]
- Updated dependencies [8518b40]
- Updated dependencies [480892a]
- Updated dependencies [e1a5e2d]
  - @namzu/sdk@3.2.0
