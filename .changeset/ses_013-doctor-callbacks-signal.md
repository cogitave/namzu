---
'@namzu/cli': patch
---

Doctor — `runDoctor()` accepts streaming callbacks + cooperative cancellation (ses_013 Phase 1).

Three new optional fields on `RunDoctorOptions`:

- **`onCheckStart(check)`** — fires immediately before each check's `run()` is invoked.
- **`onCheckComplete(record)`** — fires exactly once per check after its record is built (whether `pass`, `fail`, `inconclusive`, or `warn`). Defended against double-fire by the same `completed` map that pins the record.
- **`signal?: AbortSignal`** — cooperative cancellation. When the signal aborts, in-flight checks stop being awaited; their records become `inconclusive` with an "aborted by signal" message. Completed records are preserved verbatim.

Throwing callbacks are caught + logged + never affect the doctor run or the final `DoctorReport`.

Substrate for the upcoming TUI mode (later patch in this same series), useful standalone for analytics or custom progress UIs.

Internal: `packages/cli/tsconfig.json` adds `"jsx": "react-jsx"` + `"jsxImportSource": "react"` in preparation for the TUI's `.tsx` files. No `.tsx` files yet; typecheck still passes. Purely additive — no consumer behavior change.
