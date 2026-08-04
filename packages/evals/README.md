# @namzu/evals

Namzu's own kernel behaviour suites.

These run against a **scripted provider**, so nothing here measures a model.
That is the point: the turns are fixed, so a score that moves means the kernel
changed its behaviour. A suite that calls a real provider measures two things
at once and cannot say which one moved.

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
