---
'@namzu/sdk': minor
---

`createLogger` now understands a reserved `err` attribute. Pass the actual thrown value under that key — `logger.error('Guardrail threw — failing closed', { err })` — and the emitted record gains `exception.type` / `exception.message` / `exception.stacktrace`, built from a bounded (4-hop), cycle-safe walk of the error's `cause` chain and passed through the same record-boundary redaction scan as every other attribute.

This is purely additive: a call site that already builds `{ error: toErrorMessage(err) }` by hand is unaffected, and the two keys (`err` vs `error`) are spelled differently on purpose so both keep compiling side by side. No existing call site in the SDK has been migrated to the new key in this release.

No new named export. The reserved key and the mapper behind it (`errorAttributes`) stay internal to `@namzu/sdk` — there is no `ERR_ATTRIBUTE` or `errorAttributes` symbol on the public surface to import. A host can still reach the new behavior today by handing `createLogger`'s existing `Logger`/child-logger calls a plain `{ err: someError }` attribute, since `LogContext` already accepts an arbitrary key.

Unrelated to any provider driver's behavior: `packages/sdk/src/provider/errors.ts` still never attaches `cause` to a classified provider error, and this release does not change that — see the doc comment added there and the note in `docs/conventions/index.md`.
