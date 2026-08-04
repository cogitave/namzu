---
'@namzu/evals': minor
---

the kernel behaviour suites are publishable

`@namzu/evals` was `private: true` and carried nothing a registry needs — no
`license`, no `repository`, no `files`, no entry point. It is a real package
now, so you can run Namzu's own CI gate against the kernel *you* installed:

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
