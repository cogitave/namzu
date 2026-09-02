// Maps a thrown value to the exception.* attributes the OTel Logs Data
// Model reserves for it — exception.type / exception.message /
// exception.stacktrace — walking a `cause` chain the way a terminal
// `console.error` would: newest frame first, oldest cause last.
//
// Two things this file deliberately does NOT do:
//
//  - It does not redact anything itself. `redactRecord` (../log/redact.ts)
//    runs over every attribute value unconditionally, once, at the record
//    boundary — stack text included. A second scan here would be a second
//    place to keep LOG_SECRET_PATTERNS in sync with, and the whole point of
//    a record-boundary scan is that nothing gets to opt out of it by
//    running earlier.
//  - It does not license re-attaching `cause` where it was deliberately
//    dropped. `provider/errors.ts` refuses to keep one on a classified
//    provider error on purpose — a vendor SDK's error message (and so its
//    own `cause`, when the vendor wraps a transport error) can carry a
//    credential the upstream echoed back, and "a `cause` survives every
//    logger that serializes an error chain" is exactly the property this
//    file exists to provide. Being able to walk a `cause` safely is not the
//    same claim as every `cause` being safe to attach in the first place;
//    see that file's own doc comment and "index".

import type { LogAttributes } from './attributes.js'

/**
 * How many `cause` hops past the thrown value itself get folded into
 * `exception.stacktrace`. Four, not "as many as there are": an ordinary
 * retry-then-fallback call stack in this codebase is a handful of layers
 * deep, but nothing stops a caller from building a cause chain as long as
 * it likes, and walking all of it turns one log call into an unbounded
 * string build ahead of the 8 KiB per-value cap (caps.ts) that would
 * otherwise be the only thing catching it. The bound is enforced here,
 * explicitly, rather than left to that cap truncating mid-frame with no
 * indication anything was cut.
 */
const DEFAULT_CAUSE_DEPTH = 4

/** What a thrown non-`Error` still needs a name for. */
const UNKNOWN_EXCEPTION_TYPE = 'UnknownError'

/**
 * `exception.type` / `exception.message` / `exception.stacktrace` for a
 * thrown value. `causeDepth` overrides the default bound above — exposed
 * for tests, not because a production call site should ordinarily need a
 * different one.
 */
export function errorAttributes(
	err: unknown,
	opts?: { readonly causeDepth?: number },
): LogAttributes {
	const maxDepth = opts?.causeDepth ?? DEFAULT_CAUSE_DEPTH
	const { type, message } = describe(err)
	return {
		'exception.type': type,
		'exception.message': message,
		'exception.stacktrace': buildStacktrace(err, maxDepth),
	}
}

function describe(value: unknown): { type: string; message: string } {
	if (value instanceof Error) {
		return { type: value.name || UNKNOWN_EXCEPTION_TYPE, message: value.message }
	}
	if (typeof value === 'object' && value !== null) {
		return { type: UNKNOWN_EXCEPTION_TYPE, message: safeStringify(value) }
	}
	return { type: UNKNOWN_EXCEPTION_TYPE, message: String(value) }
}

function safeStringify(value: object): string {
	try {
		return JSON.stringify(value)
	} catch {
		// A circular non-Error thrown value. `String()` on a plain object gives
		// '[object Object]' — unhelpful, but the one thing this function must
		// never do is itself throw from inside a logging call.
		return String(value)
	}
}

/**
 * `err`'s own stack (or a `type: message` line when there is none) followed
 * by each `.cause`'s, newest first, bounded by `maxDepth` hops. Stops early
 * — WITH a note saying so, per refuse-do-not-degrade — on a cycle or on
 * reaching the bound with more chain left to walk. Never loops: every value
 * this function visits is added to `seen` before the value after it is even
 * read, so a self-referencing `cause` is caught on the very next hop rather
 * than by exhausting the depth bound.
 */
function buildStacktrace(err: unknown, maxDepth: number): string {
	const seen = new Set<unknown>([err])
	const frames: string[] = [frameText(err)]

	let cursor: unknown = err instanceof Error ? err.cause : undefined
	let depth = 0

	while (cursor !== undefined && cursor !== null) {
		if (seen.has(cursor)) {
			frames.push(`Caused by: [cause chain cycle detected at depth ${depth + 1} — stopped]`)
			return frames.join('\n')
		}
		if (depth >= maxDepth) {
			frames.push(
				`Caused by: [cause chain truncated at depth ${maxDepth} — deeper causes not walked]`,
			)
			return frames.join('\n')
		}

		seen.add(cursor)
		frames.push(`Caused by: ${frameText(cursor)}`)
		depth++
		cursor = cursor instanceof Error ? cursor.cause : undefined
	}

	return frames.join('\n')
}

function frameText(value: unknown): string {
	if (value instanceof Error) {
		return value.stack ?? `${value.name || UNKNOWN_EXCEPTION_TYPE}: ${value.message}`
	}
	return String(value)
}
