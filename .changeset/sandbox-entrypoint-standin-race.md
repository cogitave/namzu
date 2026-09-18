---
"@namzu/sandbox": patch
---

Nothing a consumer installs changes. The one edited file is
`k8s/__tests__/entrypoint.test.ts`, which `package.json#files` excludes from the
tarball; the harness only, and `entrypoint.sh` itself is deliberately untouched —
runtime behaviour, exports, types and defaults are the same.

`entrypoint.test.ts` has been intermittently red on `main`, twice in a release
run:

```
FAIL entrypoint.test.ts > entrypoint.sh prestop: the flush a stopping pod gets
   > returns rather than hanging when the init does not go
AssertionError: expected 6 to be greater than or equal to 900
```

The mechanism is a race in the harness, not in the image. `entrypoint.sh` reads
`/proc/<pid>/comm` before it signals anything and exits 0 immediately when the
name is not the init it expects — a fail-closed refusal the image must keep, and
the reason `entrypoint.sh` is not what changed here. `spawnStandIn` echoed `$!`
for a child that had not `exec`'d yet, so inside that window the hook read `sh`
where the symlinked `tini` was intended, refused, and skipped its whole wait. The
case then measured the refusal — a few milliseconds of elapsed time and a handful
of ticks — instead of the flush it is about, and failed against a constant that
looks nothing like the number it got.

The fix is a bounded, loud-failing readiness poll, `awaitStandInExec`, routed
through `spawnStandIn` so every stand-in call site gets it: cases now wait for
the process to become the binary it was started as before they hand its pid to
the hook. It waits for the SPECIFIC name rather than for `sh` to disappear,
because the name is what the hook turns on and one call site deliberately wants a
plain `sleep` to stay a `sleep`. A stand-in that died during the wait says so
instead of waiting its bound out.

It also refuses up front an expected name longer than the kernel can report: the
kernel keeps at most 15 characters in `/proc/<pid>/comm`, so a longer name could
never match and the wait would fail on its deadline rather than on the truth.
Latent today — every stand-in this suite starts is named well inside the limit —
and the guard exists so a future one is a one-line failure that names the limit.

Verified: the race reproduced deterministically before the fix, 20/20 runs green
under load after it, and removing the wait restores the failure byte-identically.
