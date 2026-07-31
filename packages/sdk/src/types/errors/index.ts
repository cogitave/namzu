import type { PlatformError } from '../common/index.js'
import { ProviderError } from '../provider/errors.js'

/**
 * What went wrong, at the granularity a HOST actually branches on.
 *
 * `PlatformError` was declared and never constructed — a shape nothing
 * produced and nothing consumed. Meanwhile the runtime threw bare `Error`
 * everywhere, so a caller catching a failure from `query()` could not tell
 * "the model rate-limited us" from "the run was configured wrong" from
 * "that checkpoint does not exist". The only recourse was matching on
 * message text, which is not an interface.
 *
 * The union stays small on purpose: each member exists because a caller
 * does something DIFFERENT about it. `provider_error` carries the finer
 * {@link ProviderErrorCode} in `details` rather than being fanned out
 * here, because that taxonomy answers the runtime's questions, not a
 * host's.
 */
export type NamzuErrorCode =
	/** The run was set up wrong — missing model, contradictory options. Retrying cannot help. */
	| 'invalid_config'
	/** The upstream model call failed. `details.providerCode` narrows it. */
	| 'provider_error'
	/** A tool could not be executed or resolved. */
	| 'tool_error'
	/** A referenced checkpoint, run or emergency dump does not exist. */
	| 'not_found'
	/** A plugin hook failed or refused. */
	| 'plugin_error'
	/** The provider or environment cannot do what the run requires. */
	| 'capability_unavailable'
	/** Persistence (checkpoint store, run store, workspace) failed. */
	| 'storage_error'
	/** Unclassified. Treated as non-retryable. */
	| 'unknown'

export interface NamzuErrorInit {
	readonly code: NamzuErrorCode
	readonly message: string
	readonly details?: Record<string, unknown>
	/** Defaults per code; pass explicitly to override. */
	readonly retryable?: boolean
	readonly cause?: unknown
}

/** Codes for which the same operation may succeed if repeated. */
const RETRYABLE: ReadonlySet<NamzuErrorCode> = new Set<NamzuErrorCode>(['storage_error'])

/**
 * A runtime failure a host can branch on.
 *
 * Implements {@link PlatformError} so the declared shape finally has a
 * producer, and extends `Error` so it still behaves like one everywhere
 * that only knows about `Error` — stack, `instanceof`, `cause`.
 */
export class NamzuError extends Error implements PlatformError {
	readonly code: NamzuErrorCode
	readonly details: Record<string, unknown> | undefined
	readonly retryable: boolean

	constructor(init: NamzuErrorInit) {
		super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined)
		this.name = 'NamzuError'
		this.code = init.code
		this.details = init.details
		this.retryable = init.retryable ?? RETRYABLE.has(init.code)
	}
}

export function isNamzuError(err: unknown): err is NamzuError {
	return err instanceof NamzuError
}

/**
 * Normalize ANYTHING thrown into the declared shape.
 *
 * This is what makes `PlatformError` worth having: a host wraps one call
 * and gets a consistent `{ code, message, details, retryable }` no matter
 * what came out — a `NamzuError`, a `ProviderError`, a plain `Error` from
 * a dependency, or a thrown string. Without it, "handle errors from the
 * SDK" means writing the same defensive `instanceof` ladder in every
 * caller.
 *
 * A `ProviderError` keeps its classification: its code lands in
 * `details.providerCode` and its `retryable` verdict is preserved rather
 * than recomputed, because that verdict already encodes what the provider
 * taxonomy knows and this one does not.
 */
export function toPlatformError(err: unknown): PlatformError {
	if (isNamzuError(err)) {
		return {
			code: err.code,
			message: err.message,
			...(err.details ? { details: err.details } : {}),
			retryable: err.retryable,
		}
	}

	if (err instanceof ProviderError) {
		return {
			code: 'provider_error',
			message: err.message,
			details: {
				providerCode: err.code,
				...(err.providerId !== undefined ? { providerId: err.providerId } : {}),
				...(err.status !== undefined ? { status: err.status } : {}),
				...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
			},
			retryable: err.retryable,
		}
	}

	if (err instanceof Error) {
		return { code: 'unknown', message: err.message, retryable: false }
	}

	// A thrown non-Error is rare and usually a bug elsewhere, but losing it
	// entirely is worse than reporting it as-is.
	return { code: 'unknown', message: String(err), retryable: false }
}
