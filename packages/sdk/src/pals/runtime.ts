import type {
	PalAdmission,
	PalAdmissionRequest,
	PalEnvironmentLease,
	PalRuntimeOptions,
} from './types.js'

export class PalUnavailableError extends Error {
	override readonly name = 'PalUnavailableError'
}

/** One host-owned local computer and one active input controller per Pal. */
export class PalRuntime {
	private readonly computers = new Map<string, PalEnvironmentLease>()
	private readonly starting = new Map<string, Promise<PalEnvironmentLease>>()
	private readonly controllers = new Map<string, symbol>()
	private readonly stopping = new Set<string>()
	private readonly failures = new Map<string, string>()
	private closing: Promise<void> | undefined
	private closed = false
	constructor(private readonly options: PalRuntimeOptions) {}

	computer(palId: string): PalEnvironmentLease | null {
		const lease = this.computers.get(palId)
		if (lease && lease.sandbox.status !== 'ready' && lease.sandbox.status !== 'busy')
			this.failures.set(palId, 'This Pal computer retired. Stop it before starting it again.')
		return this.failures.has(palId) || this.stopping.has(palId) ? null : (lease ?? null)
	}
	computerError(palId: string): string | null {
		this.computer(palId)
		return this.failures.get(palId) ?? null
	}
	busy(palId: string): boolean {
		return this.controllers.has(palId) || this.starting.has(palId) || this.stopping.has(palId)
	}
	async startComputer(palId: string, signal?: AbortSignal): Promise<PalEnvironmentLease> {
		signal?.throwIfAborted()
		if (this.closed) throw new PalUnavailableError('The Pal runtime is closed.')
		if (this.stopping.has(palId)) throw new PalUnavailableError('This Pal computer is stopping.')
		if (this.failures.has(palId))
			throw new PalUnavailableError(this.failures.get(palId) ?? 'This Pal computer is unavailable.')
		const pal = this.options.store.get(palId)
		if (!pal || pal.paused) throw new PalUnavailableError('This Pal is paused or unavailable.')
		const held = this.computers.get(palId)
		if (held) {
			if (held.sandbox.status !== 'ready' && held.sandbox.status !== 'busy')
				throw new PalUnavailableError(
					'This Pal computer retired. Stop it before starting it again.',
				)
			return held
		}
		const pending = this.starting.get(palId)
		if (pending) {
			const lease = await pending
			signal?.throwIfAborted()
			return lease
		}
		const provider = this.options.environments
		if (!provider) throw new PalUnavailableError('This Pal needs a ready local virtual computer.')
		const start = (async () => {
			const lease = await provider.acquire({
				pal,
				conversationId: `computer:${pal.id}`,
				...(signal ? { signal } : {}),
			})
			try {
				signal?.throwIfAborted()
				const latest = this.options.store.get(pal.id)
				if (this.closed || !latest || latest.paused || latest.workspace !== pal.workspace)
					throw new PalUnavailableError('This Pal became unavailable while starting its computer.')
				if (
					lease.palId !== pal.id ||
					!lease.environmentId?.trim() ||
					!Number.isSafeInteger(lease.generation) ||
					lease.generation < 1 ||
					!lease.sandbox ||
					!lease.computerUseHost ||
					!lease.computerUseHost.capabilities.screenshot ||
					!lease.computerUseHost.capabilities.mouse ||
					!lease.computerUseHost.capabilities.keyboard ||
					(lease.sandbox.status !== 'ready' && lease.sandbox.status !== 'busy')
				)
					throw new PalUnavailableError(
						'The virtual computer lease does not match this Pal or is not ready.',
					)
				this.computers.set(palId, lease)
				return lease
			} catch (error) {
				try {
					await lease.release()
				} catch (releaseError) {
					this.computers.set(palId, lease)
					this.failures.set(
						palId,
						'A rejected Pal computer could not be released. Retry stopping it.',
					)
					throw new AggregateError(
						[error, releaseError],
						'Pal computer admission and cleanup failed.',
					)
				}
				throw error
			}
		})()
		this.starting.set(palId, start)
		try {
			return await start
		} finally {
			if (this.starting.get(palId) === start) this.starting.delete(palId)
		}
	}
	async stopComputer(palId: string): Promise<void> {
		if (this.stopping.has(palId))
			throw new PalUnavailableError('This Pal computer is already stopping.')
		if (this.controllers.has(palId))
			throw new PalUnavailableError('Stop this Pal’s active work before stopping its computer.')
		if (this.starting.has(palId))
			throw new PalUnavailableError('Wait for this Pal computer to finish starting.')
		const lease = this.computers.get(palId)
		if (!lease) return
		this.stopping.add(palId)
		try {
			await lease.release()
			if (this.computers.get(palId) === lease) this.computers.delete(palId)
			this.failures.delete(palId)
		} catch (error) {
			this.failures.set(palId, 'The Pal computer could not be stopped. Retry stopping it.')
			throw error
		} finally {
			this.stopping.delete(palId)
		}
	}
	async admit(request: PalAdmissionRequest): Promise<PalAdmission> {
		request.signal?.throwIfAborted()
		if (!request.conversationId.trim()) throw new Error('A Pal conversation id is required.')
		if (this.closed) throw new PalUnavailableError('The Pal runtime is closed.')
		const current = this.options.store.get(request.palId)
		if (!current || current.paused)
			throw new PalUnavailableError('This Pal is paused or unavailable.')
		const definition =
			request.revision === undefined
				? current
				: this.options.store.getRevision(current.id, request.revision)
		if (this.controllers.has(current.id))
			throw new PalUnavailableError('This Pal computer is busy in another conversation.')
		const owner = Symbol(request.conversationId)
		this.controllers.set(current.id, owner)
		try {
			const lease = await this.startComputer(current.id, request.signal)
			let released = false
			const assertActive = () => {
				request.signal?.throwIfAborted()
				if (
					released ||
					this.closed ||
					this.controllers.get(current.id) !== owner ||
					this.computers.get(current.id) !== lease
				)
					throw new PalUnavailableError('This Pal admission no longer owns its computer.')
				if (lease.sandbox.status !== 'ready' && lease.sandbox.status !== 'busy')
					throw new PalUnavailableError('This Pal computer retired during its work.')
				const latest = this.options.store.get(definition.id)
				if (!latest || latest.paused)
					throw new PalUnavailableError('This Pal is paused or unavailable.')
				if (latest.workspace !== definition.workspace)
					throw new PalUnavailableError('Pal workspace identity changed.')
			}
			assertActive()
			return {
				definition,
				lease,
				assertActive,
				release: async () => {
					if (released) return
					released = true
					if (this.controllers.get(current.id) === owner) this.controllers.delete(current.id)
				},
			}
		} catch (error) {
			if (this.controllers.get(current.id) === owner) this.controllers.delete(current.id)
			throw error
		}
	}
	async close(): Promise<void> {
		if (this.closing) return this.closing
		this.closed = true
		const closing = (async () => {
			await Promise.allSettled(this.starting.values())
			this.controllers.clear()
			const results = await Promise.allSettled(
				[...this.computers.keys()].map((id) => this.stopComputer(id)),
			)
			const failures = results
				.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
				.map((result) => result.reason)
			if (failures.length) throw new AggregateError(failures, 'Failed to stop Pal computers.')
		})()
		this.closing = closing
		try {
			await closing
		} finally {
			if (this.closing === closing) this.closing = undefined
		}
	}
}
