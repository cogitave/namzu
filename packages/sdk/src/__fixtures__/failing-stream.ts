import type { StreamChunk } from '../types/provider/index.js'

/**
 * A provider stream that fails on the first pull.
 *
 * Every retry, fallback and provenance test needs one, and each had written
 * it inline as `(async function* () { throw err; yield chunk })()` — seven
 * copies, each carrying TWO suppression comments to survive lint. This is
 * that construct, once, with the reason written down.
 *
 * **Why the unreachable `yield` is there.** JavaScript does not need it:
 * `async function*` is a generator by syntax, and one whose body only throws
 * is still an async generator that rejects on the first `next()`. Biome's
 * `lint/correctness/useYield` requires one anyway — a generator that never
 * yields is usually a mistake, and the rule cannot tell this case from that
 * one. So the `yield` exists to satisfy the linter, and it is unreachable by
 * construction.
 *
 * The earlier inline copies suppressed `noUnreachable` and carried an
 * `eslint-disable-next-line require-yield` beside it — a suppression naming
 * a linter this repo does not run, which had no effect on anything. One
 * `useYield` suppression here replaces all fourteen.
 *
 * **Fails on ITERATION, not on call**, which is how a real provider fails:
 * `chatStream(...)` returns, the request is in flight, and the error surfaces
 * when the consumer pulls the first chunk.
 *
 * That distinction is NOT pinned by the tests using this, and the claim is
 * here with its limit rather than without it. Measured: replacing this with a
 * plain `function` that throws synchronously leaves all 35 of them green,
 * because every call site is a thunk (`() => failingStream(err)`) invoked at
 * the point of iteration — so the throw lands inside the same `try` either
 * way. A consumer that called `chatStream` early and iterated later could
 * tell the difference; none of these do.
 */
// biome-ignore lint/correctness/useYield: unreachable by construction — see above
export async function* failingStream(error: unknown): AsyncGenerator<StreamChunk> {
	throw error
}
