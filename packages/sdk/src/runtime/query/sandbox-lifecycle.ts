import type { Sandbox, SandboxCreateConfig, SandboxProvider } from '../../types/sandbox/index.js'

const MAX_TIMER_DELAY_MS = 2_147_483_647

/** A sandbox release gets thirty seconds before the run stops waiting for it. */
export const DEFAULT_SANDBOX_TEARDOWN_TIMEOUT_MS = 30_000

export function resolveSandboxTeardownTimeoutMs(value: number | undefined): number {
	const resolved = value ?? DEFAULT_SANDBOX_TEARDOWN_TIMEOUT_MS
	if (!Number.isInteger(resolved) || resolved < 0 || resolved > MAX_TIMER_DELAY_MS) {
		throw new RangeError(
			`sandboxTeardownTimeoutMs must be an integer from 0 to ${MAX_TIMER_DELAY_MS}; received ${String(resolved)}`,
		)
	}
	return resolved
}

export type SandboxTeardownResult =
	| { readonly kind: 'destroyed' }
	| { readonly kind: 'failed'; readonly error: unknown }
	| { readonly kind: 'timed_out'; readonly error: Error }

export type SandboxAcquisitionResult =
	| { readonly kind: 'created'; readonly sandbox: Sandbox }
	| { readonly kind: 'cancelled'; readonly createPending: boolean }
	| { readonly kind: 'timed_out'; readonly createPending: boolean; readonly error: Error }

function teardownTimeoutError(timeoutMs: number): Error {
	const error = new Error(`Sandbox teardown timed out after ${timeoutMs}ms`)
	error.name = 'TimeoutError'
	return error
}

function acquisitionTimeoutError(timeoutMs: number): Error {
	const error = new Error(
		`Sandbox creation exceeded the remaining run timeout after ${timeoutMs}ms`,
	)
	error.name = 'TimeoutError'
	return error
}

function notifyLateTeardown(
	notify: ((result: SandboxTeardownResult) => void) | undefined,
	result: SandboxTeardownResult,
): void {
	try {
		notify?.(result)
	} catch {
		// An observer is not the teardown owner. The sandbox has already settled,
		// and an operational log callback must not turn cancellation into an
		// unhandled rejection or retract its result.
	}
}

/**
 * Release a sandbox under a fresh owner.
 *
 * The run signal is deliberately not an input: cleanup normally begins because
 * that signal is already aborted. A private signal gives the implementation a
 * chance to stop its transport at the teardown deadline, while the independent
 * race keeps a third-party implementation that ignores it from pinning the run.
 */
export async function teardownSandbox(
	sandbox: Sandbox,
	timeoutMs: number,
): Promise<SandboxTeardownResult> {
	const controller = new AbortController()
	const operation = Promise.resolve()
		.then(() => sandbox.destroy({ signal: controller.signal }))
		.then<SandboxTeardownResult, SandboxTeardownResult>(
			() => ({ kind: 'destroyed' }),
			(error: unknown) => ({ kind: 'failed', error }),
		)

	if (timeoutMs === 0) return await operation

	let timer: ReturnType<typeof setTimeout> | undefined
	let timedOut: Error | undefined
	const deadline = new Promise<SandboxTeardownResult>((resolve) => {
		timer = setTimeout(() => {
			timedOut = teardownTimeoutError(timeoutMs)
			controller.abort(timedOut)
			resolve({ kind: 'timed_out', error: timedOut })
		}, timeoutMs)
	})

	try {
		const result = await Promise.race([operation, deadline])
		// A destroy implementation may synchronously translate our abort into a
		// generic AbortError. The deadline remains the cause that won.
		return timedOut ? { kind: 'timed_out', error: timedOut } : result
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

/**
 * Acquire a sandbox without allowing foreign setup to outlive run authority.
 *
 * Cancellation or the run timeout settles this function even when a provider
 * ignores the signal.
 * A handle that arrives later is never published and is released exactly once.
 * This proves host/run liveness and cleanup of every handle the provider
 * returns. It cannot prove that a remote service did not commit an allocation
 * behind a response that never disclosed its identity; that requires a
 * provider-owned reconciliation key or fleet reaper.
 */
export async function acquireSandbox(options: {
	readonly provider: SandboxProvider
	readonly config: Omit<SandboxCreateConfig, 'signal'>
	readonly signal: AbortSignal
	/** Remaining wall-clock owned by the run, not a second sandbox budget. */
	readonly timeoutMs: number
	readonly teardownTimeoutMs: number
	readonly onLateTeardown?: (result: SandboxTeardownResult) => void
}): Promise<SandboxAcquisitionResult> {
	const { provider, signal: runSignal } = options
	if (runSignal.aborted) return { kind: 'cancelled', createPending: false }
	if (options.timeoutMs <= 0) {
		return {
			kind: 'timed_out',
			createPending: false,
			error: acquisitionTimeoutError(options.timeoutMs),
		}
	}

	const operationController = new AbortController()
	const signal = operationController.signal
	let timeoutError: Error | undefined
	let timer: ReturnType<typeof setTimeout> | undefined

	let onAbort!: () => void
	const aborted = new Promise<{ readonly kind: 'cancelled' }>((resolve) => {
		onAbort = () => {
			operationController.abort(runSignal.reason)
			resolve({ kind: 'cancelled' })
		}
		runSignal.addEventListener('abort', onAbort, { once: true })
	})
	const timedOut = new Promise<{ readonly kind: 'timed_out'; readonly error: Error }>((resolve) => {
		timer = setTimeout(() => {
			timeoutError = acquisitionTimeoutError(options.timeoutMs)
			operationController.abort(timeoutError)
			resolve({ kind: 'timed_out', error: timeoutError })
		}, options.timeoutMs)
	})

	// Authority may be withdrawn between the first check and listener
	// installation. Refuse before the provider gets a chance to allocate.
	if (runSignal.aborted) {
		runSignal.removeEventListener('abort', onAbort)
		if (timer !== undefined) clearTimeout(timer)
		return { kind: 'cancelled', createPending: false }
	}

	type Settled =
		| { readonly kind: 'created'; readonly sandbox: Sandbox }
		| { readonly kind: 'failed'; readonly error: unknown }
	let settled: Promise<Settled>
	try {
		settled = Promise.resolve(provider.create({ ...options.config, signal })).then(
			(sandbox) => ({ kind: 'created' as const, sandbox }),
			(error: unknown) => ({ kind: 'failed' as const, error }),
		)
	} catch (error) {
		runSignal.removeEventListener('abort', onAbort)
		if (timer !== undefined) clearTimeout(timer)
		throw error
	}

	try {
		const winner = await Promise.race([settled, aborted, timedOut])
		if (winner.kind === 'failed') {
			// A provider may translate our timeout abort into a generic AbortError
			// before the deadline promise's continuation runs. The timeout remains
			// the first cause and must not be misreported as a provider failure.
			if (timeoutError) {
				return { kind: 'timed_out', createPending: false, error: timeoutError }
			}
			throw winner.error
		}

		if (winner.kind === 'created') {
			// The provider promise can settle, queue this continuation, and then
			// lose authority in another queued microtask. Publication is a separate
			// boundary from settlement, so fence it independently.
			if (!signal.aborted) return winner
			const result = await teardownSandbox(winner.sandbox, options.teardownTimeoutMs)
			notifyLateTeardown(options.onLateTeardown, result)
			return timeoutError
				? { kind: 'timed_out', createPending: false, error: timeoutError }
				: { kind: 'cancelled', createPending: false }
		}

		// Keep the losing setup promise observed. A late handle is cleanup work,
		// not a capability the stopped run may publish; a late rejection has
		// nobody left to notify and is deliberately consumed.
		void settled.then(async (late) => {
			if (late.kind !== 'created') return
			const result = await teardownSandbox(late.sandbox, options.teardownTimeoutMs)
			notifyLateTeardown(options.onLateTeardown, result)
		})
		return winner.kind === 'timed_out'
			? { kind: 'timed_out', createPending: true, error: winner.error }
			: { kind: 'cancelled', createPending: true }
	} finally {
		runSignal.removeEventListener('abort', onAbort)
		if (timer !== undefined) clearTimeout(timer)
	}
}
