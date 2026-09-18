---
"@namzu/sandbox": patch
---

Nothing a consumer installs changes. The one edited file is
`src/backends/docker/__tests__/leaf-permissions.smoke.test.ts`, which
`package.json#files` excludes from the tarball; runtime behaviour, exports, types
and defaults are untouched.

The `Sandbox smoke` workflow has been red on `main` since the docker hardening
landed (`481fb8ff`, `--read-only` on by default). That case asserts that uid 1001
cannot `mkdir` into the unbound `/mnt/user-data`, and it pinned the refusal to
one spelling — `permission denied`. With a read-only rootfs the kernel answers
`read-only file system` instead, because EROFS is consulted before the DAC check
that would have produced EACCES. The property the case exists for never changed
(a bound writable leaf would let the `mkdir` succeed, and the `--rc` assertion
still catches that); only the kernel's wording did.

The assertion now accepts either refusal and says why both are legitimate, so the
next change to which check fires first is a one-line read rather than a day of
red. `dash` and Docker are both absent from the machine this was written on, so
the fix is verified by the workflow that runs this file, not locally.
