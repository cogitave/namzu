import type { Sandbox } from '../../types/sandbox/index.js'
import type { SandboxAcquisitionResult } from './sandbox-lifecycle.js'

/**
 * When a turn starts acquiring its sandbox.
 *
 * - `'eager'`: before the input guardrails and the first model request, and the
 *   turn waits for it. This is the behaviour every sandboxed turn had before
 *   the option existed.
 * - `'concurrent'`: at the same point, but the turn does not wait. The first
 *   model request goes out while the provider allocates, and the first tool
 *   call waits for the handle.
 * - `'on-first-use'`: not until the first tool call needs one.
 */
export type SandboxAcquireMode = 'eager' | 'concurrent' | 'on-first-use'

export type SandboxAcquisitionStop = Exclude<SandboxAcquisitionResult, { kind: 'created' }>

/**
 * A deferred acquisition ended without a sandbox for a reason the turn settles
 * with a stop reason (`cancelled`, `timeout`), exactly as an eager acquisition
 * does. A provider failure is not wrapped: it propagates as the provider's own
 * error, as it does when the turn waits.
 */
export class SandboxAcquisitionStopped extends Error {
	readonly acquisition: SandboxAcquisitionStop

	constructor(acquisition: SandboxAcquisitionStop) {
		super(
			acquisition.kind === 'timed_out'
				? acquisition.error.message
				: 'Sandbox acquisition was cancelled before it finished',
		)
		this.name = 'SandboxAcquisitionStopped'
		this.acquisition = acquisition
	}
}

type Outcome = SandboxAcquisitionResult | { readonly kind: 'failed'; readonly error: unknown }

export interface DeferredSandbox {
	/** Start acquiring if nothing has yet. Idempotent. */
	start(): void
	/** Start if needed, then wait for the handle to be published. Throws when none will be. */
	ensure(): Promise<void>
	/**
	 * Wait for an acquisition that was started. A no-op when none was, and when
	 * the turn has already been cancelled (the loop settles that on its own).
	 */
	settle(): Promise<void>
	/** Withdraw authority from a still-pending acquisition and wait until it has settled. Never throws. */
	cancel(): Promise<void>
}

/**
 * A sandbox acquisition that outlives the point that started it.
 *
 * `acquire` is the same lifecycle function an eager turn uses, so a late
 * handle, a timeout and a cancellation are released by the machinery that
 * already owns them. `publish` runs once, when (and only when) the handle
 * arrived in time, so `sandbox_created` marks the moment of resolution.
 */
export function createDeferredSandbox(options: {
	readonly turnSignal: AbortSignal
	readonly acquire: (signal: AbortSignal) => Promise<SandboxAcquisitionResult>
	readonly publish: (sandbox: Sandbox) => Promise<void>
}): DeferredSandbox {
	const controller = new AbortController()
	const relay = (): void => controller.abort(options.turnSignal.reason)
	if (options.turnSignal.aborted) relay()
	else options.turnSignal.addEventListener('abort', relay, { once: true })

	let outcome: Promise<Outcome> | undefined
	const start = (): Promise<Outcome> => {
		outcome ??= (async (): Promise<Outcome> => {
			try {
				const acquired = await options.acquire(controller.signal)
				if (acquired.kind === 'created') await options.publish(acquired.sandbox)
				return acquired
			} catch (error) {
				return { kind: 'failed', error }
			}
		})()
		return outcome
	}

	const rethrow = (settled: Outcome): void => {
		if (settled.kind === 'created') return
		if (settled.kind === 'failed') throw settled.error
		throw new SandboxAcquisitionStopped(settled)
	}

	return {
		start: () => {
			void start()
		},
		ensure: async () => rethrow(await start()),
		settle: async () => {
			if (outcome === undefined) return
			const settled = await outcome
			if (options.turnSignal.aborted) return
			rethrow(settled)
		},
		cancel: async () => {
			options.turnSignal.removeEventListener('abort', relay)
			controller.abort()
			if (outcome !== undefined) await outcome
		},
	}
}
