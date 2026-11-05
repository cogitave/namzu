---
'@namzu/ag-ui': major
---

The `zod` peer range moves from `^3.23.0` to `^4.1.0`, to match `@namzu/sdk`, which now builds and describes tool input with Zod 4. A frontend tool schema you pass in must be built with Zod 4 (`z.record(z.string(), value)` takes two arguments there). Upgrade `zod` in your project to keep using this package.
