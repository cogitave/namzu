---
'@namzu/cli': patch
---

`namzu doctor` reported installed optional packages as missing. `@namzu/files` and `@namzu/telemetry` both read "not installed (optional package)" on machines where they were installed and working, and the boot narrative's capability line said the same.

`probeOptionalPackage` asked `require.resolve` whether a package was on disk. That is not the question it answers: it answers whether CJS may load the package's entry point, and every optional package here is ESM-only with an `exports` map that declares `import` and no `default`, so the resolver correctly throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. The probe read that throw as `absent`.

`@namzu/sdk` is what hid it. Its exports map carries a `default` condition, so it was the one specifier in the tree that resolved — anybody spot-checking the probe against it saw the right answer.

The probe now walks `node_modules` upward for `<specifier>/package.json`, which is resolver-agnostic and is what "installed" means. `import.meta.resolve` would also have been correct and is not available under the test runner's module transform, so a probe built on it could not have been held by the tests that are supposed to hold it.

The existing tests all drove an absolute fixture path, because there is no way to uninstall a real package inside a test run — so none of them reached the bare-specifier branch where the defect lived. Two regression tests now do, one in each direction.

`telemetry.sessionExport` resolves `@namzu/telemetry` through this same probe rather than a second copy, so it inherits the fix and cannot drift from what the doctor reports.
