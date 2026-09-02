---
title: The eval suites — the two kinds, running them and what a suite is
description: Reference for @namzu/evals: why the kernel suites and the security suites are scored differently, how to run either against an installed kernel, what a suite file contains, and how a suite is versioned so a score stays comparable across releases.
type: Reference
status: stable
resource: packages/evals/kernel
tags: [evals, testing, reference]
generated: { by: human:bahadirarda, at: 2026-08-17T00:00:00Z }
---

# The eval suites — the two kinds, running them and what a suite is

Namzu's own behaviour and security suites.

Nothing here measures a model. The kernel suites run against a **scripted
provider** and the security suites touch no provider at all, so a score that
moves means the code changed its behaviour. A suite that calls a real provider
measures two things at once and cannot say which one moved.

## The two kinds

- **`kernel/`** — invariants of the agent loop, driven against a scripted
  provider. Every case pins something this kernel has broken at least once.
- **`security/`** — deterministic probes for properties that are easy to get
  wrong and hard to notice. No provider, no kernel, no network.

### `security/oauth-state` — does `state` derive from the PKCE verifier?

In authorization code + PKCE, only the *challenge* — the hash of the verifier —
may travel in the authorization URL. `state` travels in that URL too, so a flow
that sets `state = verifier` writes the verifier into the address bar, the
browser history and any referrer, and the protection PKCE exists to provide is
gone while every part of the ceremony is still present.

**The assertion a careful person writes does not catch it.** `state !== challenge`
holds for the broken flow — necessarily, because the challenge is the SHA-256 of
the verifier — so the check passes while the property is broken. Even
`state !== verifier` only catches literal reuse; a slice, a re-encoding, a
reversal or a second hash all still couple the two.

The probe is importable, so you can point it at your own flow:

```js
import {
  auditAuthorizationRequest,
} from '@namzu/evals/security/oauth-state.js'

const { sound, findings } = auditAuthorizationRequest({ url, state, verifier })
if (!sound) throw new Error(findings.join('; '))
```

It answers with the **name** of the relation it found — "state is the verifier,
reversed" sends you to the line; "unsound" sends you to re-read a flow you
believe is correct. It reads one captured attempt and enumerates a fixed list of
derivations, so a relation outside that list would pass: presence of a finding
is proof of coupling, absence is not proof of independence. The list is written
out in the source rather than described, so you can see how far the answer
reaches.

## What it is for

Namzu runs these as a required CI gate. Published so you can run the same gate
against the kernel *you* installed — pin a version, run the suites, and see
whether the loop still behaves the way the suites pin it.

If you are writing your own evals, you do not need this package. The runner is
`namzu eval` in [`@namzu/cli`](https://www.npmjs.com/package/@namzu/cli) and the
report types are in [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk);
this one is only the suites.

## Running them

```sh
npm install --save-dev @namzu/evals @namzu/cli
npx namzu eval --dir node_modules/@namzu/evals
```

Exit codes are the ones `namzu eval` defines: `0` passed, `1` failed, `2`
inconclusive, `3` usage. A hung suite reports `2` rather than `1` — "we could
not tell" is a different answer from "it was wrong", and a CI gate that
conflates them fails for the wrong reason.

## What a suite is

A `*.eval.js` file that default-exports an async function returning an
`ExperimentReport`. Plain JavaScript rather than TypeScript on purpose: the
runner loads a suite with `import()`, and the supported Node range does not
strip types everywhere.

```js
export default async function toolLoop() {
  // …drive the kernel against a scripted provider, score what came back
}
```

## Versioning

The suites pin invariants of a specific kernel. `@namzu/sdk` is a **peer**
dependency (`>=5.0.0`) rather than a direct one, so they run against the kernel
your project already installed rather than pulling a second copy — which would
mean scoring a kernel you are not shipping.
