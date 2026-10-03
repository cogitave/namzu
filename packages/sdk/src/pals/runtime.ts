import type {
	ComputerUseAction,
	ComputerUseHost,
	ComputerUseResult,
} from '../types/computer-use/index.js'
import { PalLifecycleEmitter, type PalLifecycleListener } from './lifecycle.js'
import type {
	PalAdmission,
	PalAdmissionRequest,
	PalComputerControl,
	PalComputerControlState,
	PalComputerInput,
	PalComputerScreenStream,
	PalEnvironmentLease,
	PalRuntimeOptions,
} from './types.js'

export class PalUnavailableError extends Error {
	override readonly name = 'PalUnavailableError'
}

function captureInput(input: PalComputerInput): PalComputerInput {
	const invalid = () => new Error('Invalid Pal computer input.')
	const shape = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
		!!value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	const point = (value: unknown) => {
		if (
			!shape(value, ['x', 'y']) ||
			!Number.isSafeInteger(value.x) ||
			!Number.isSafeInteger(value.y) ||
			(value.x as number) < 0 ||
			(value.y as number) < 0 ||
			(value.x as number) > 32767 ||
			(value.y as number) > 32767
		)
			throw invalid()
		return { x: value.x as number, y: value.y as number }
	}
	const button = (value: unknown) => {
		if (value !== 'left' && value !== 'right' && value !== 'middle') throw invalid()
		return value
	}
	if (!input || typeof input !== 'object') throw invalid()
	switch (input.type) {
		case 'mouse_move':
			if (!shape(input, ['type', 'to'])) throw invalid()
			return { type: input.type, to: point(input.to) }
		case 'mouse_click':
			if (!shape(input, ['type', 'at', 'button'])) throw invalid()
			return { type: input.type, at: point(input.at), button: button(input.button) }
		case 'mouse_drag':
			if (!shape(input, ['type', 'from', 'to', 'button'])) throw invalid()
			return {
				type: input.type,
				from: point(input.from),
				to: point(input.to),
				button: button(input.button),
			}
		case 'scroll':
			if (
				!shape(input, ['type', 'at', 'direction', 'amount']) ||
				!['up', 'down', 'left', 'right'].includes(input.direction) ||
				!Number.isSafeInteger(input.amount) ||
				input.amount < 1 ||
				input.amount > 100
			)
				throw invalid()
			return {
				type: input.type,
				at: point(input.at),
				direction: input.direction,
				amount: input.amount,
			}
		case 'type_text':
			if (
				!shape(input, ['type', 'text']) ||
				typeof input.text !== 'string' ||
				input.text.length > 100_000 ||
				input.text.includes('\0')
			)
				throw invalid()
			return { type: input.type, text: input.text }
		case 'key':
			if (
				!shape(input, ['type', 'keys']) ||
				typeof input.keys !== 'string' ||
				!input.keys.trim() ||
				input.keys.length > 100 ||
				!/^[a-zA-Z0-9_+ -]+$/.test(input.keys)
			)
				throw invalid()
			return { type: input.type, keys: input.keys }
		default:
			throw invalid()
	}
}

function controlMode(control: PalComputerControl): PalComputerControl['mode'] {
	return control.mode
}

function freshAdmissionComputer(host: ComputerUseHost, assertActive: () => void): ComputerUseHost {
	let observed = false
	const requireScreen = () => {
		if (!observed)
			throw new PalUnavailableError(
				'Capture a fresh Pal computer screenshot after operator control before sending GUI input.',
			)
	}
	return new Proxy(Object.create(host) as ComputerUseHost, {
		get(_target, property) {
			const value = Reflect.get(host, property, host)
			if (typeof value !== 'function') return value
			if (property === 'execute')
				return async (action: ComputerUseAction) => {
					assertActive()
					if (action.type !== 'screenshot' && action.type !== 'cursor_position') requireScreen()
					const result: ComputerUseResult = await host.execute(action)
					assertActive()
					if (action.type === 'screenshot' && result.type === 'screenshot') observed = true
					return result
				}
			return async (...args: unknown[]) => {
				assertActive()
				if (property === 'focusWindow' || property === 'executeWindow' || property === 'uiAct')
					requireScreen()
				const result = await Reflect.apply(value, host, args)
				assertActive()
				return result
			}
		},
	})
}

/** One host-owned local computer and one active input controller per Pal. */
export class PalRuntime {
	private readonly computers = new Map<string, PalEnvironmentLease>()
	private readonly starting = new Map<string, Promise<PalEnvironmentLease>>()
	private readonly controllers = new Map<
		string,
		{ readonly conversationId: string; generation?: number }
	>()
	private readonly lifecycle = new PalLifecycleEmitter()
	private readonly stopping = new Set<string>()
	private readonly freshScreenRequired = new Set<string>()
	private readonly controlOperations = new Map<
		string,
		{ readonly transition: boolean; readonly promise: Promise<unknown> }
	>()
	private readonly failures = new Map<string, string>()
	private closing: Promise<void> | undefined
	private closed = false
	constructor(private readonly options: PalRuntimeOptions) {}

	/** Live observations only. Unsubscribe does not stop the Pal or its computer. */
	onLifecycle(listener: PalLifecycleListener): () => void {
		return this.lifecycle.on(listener)
	}

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
	/** Trusted host observation only. The credentials do not grant guest input authority. */
	computerScreenStream(palId: string, generation: number): PalComputerScreenStream {
		if (this.closed) throw new PalUnavailableError('The Pal runtime is closed.')
		if (!Number.isSafeInteger(generation) || generation < 1)
			throw new PalUnavailableError('Invalid Pal computer generation.')
		const pal = this.options.store.get(palId)
		const lease = this.computer(palId)
		if (
			!pal ||
			!lease ||
			lease.palId !== pal.id ||
			lease.generation !== generation ||
			this.starting.has(palId) ||
			this.stopping.has(palId)
		)
			throw new PalUnavailableError('This Pal computer generation is unavailable or changed.')
		const stream = lease.screenStream
		if (!stream) throw new PalUnavailableError('This Pal computer does not support a live screen.')
		const { protocol, url, authorization } = stream
		const bounded = (value: unknown): value is string =>
			typeof value === 'string' &&
			value.length > 0 &&
			value.length <= 4096 &&
			value.trim() === value &&
			![...value].some((character) => {
				const code = character.charCodeAt(0)
				return code < 32 || code === 127
			})
		if (protocol !== 'rfb' || !bounded(url) || !bounded(authorization))
			throw new PalUnavailableError('The Pal computer returned an invalid live screen descriptor.')
		let target: URL
		try {
			target = new URL(url)
		} catch {
			throw new PalUnavailableError('The Pal computer returned an invalid live screen descriptor.')
		}
		if (
			(target.protocol !== 'ws:' && target.protocol !== 'wss:') ||
			target.username ||
			target.password ||
			this.computer(palId) !== lease ||
			lease.generation !== generation
		)
			throw new PalUnavailableError('The Pal computer returned an invalid live screen descriptor.')
		return Object.freeze({ protocol, url, authorization })
	}
	/** Actual provider authority, including a transition reserved by this runtime. */
	computerControl(palId: string): PalComputerControlState {
		const lease = this.computer(palId)
		if (!lease) return { supported: false, mode: 'unavailable' }
		if (!lease.operatorControl) return { supported: false, mode: 'unavailable' }
		if (this.controlOperations.get(palId)?.transition)
			return { supported: true, mode: 'transitioning' }
		const mode = lease.operatorControl.mode
		return mode === 'pal' || mode === 'operator' || mode === 'transitioning'
			? { supported: true, mode }
			: { supported: true, mode: 'unavailable' }
	}
	busy(palId: string): boolean {
		return (
			this.controllers.has(palId) ||
			this.starting.has(palId) ||
			this.stopping.has(palId) ||
			this.controlOperations.has(palId) ||
			(this.computers.get(palId)?.operatorControl?.mode !== undefined &&
				this.computers.get(palId)?.operatorControl?.mode !== 'pal')
		)
	}
	private ownedControl(palId: string, generation: number) {
		if (this.closed) throw new PalUnavailableError('The Pal runtime is closed.')
		if (!Number.isSafeInteger(generation) || generation < 1)
			throw new PalUnavailableError('Invalid Pal computer generation.')
		const pal = this.options.store.get(palId)
		const lease = this.computer(palId)
		if (
			!pal ||
			!lease ||
			lease.palId !== pal.id ||
			lease.generation !== generation ||
			this.starting.has(palId) ||
			this.stopping.has(palId)
		)
			throw new PalUnavailableError('This Pal computer generation is unavailable or changed.')
		if (this.controllers.has(palId))
			throw new PalUnavailableError('Stop this Pal’s active work before taking computer control.')
		if (this.controlOperations.has(palId))
			throw new PalUnavailableError('This Pal computer control operation is still pending.')
		if (!lease.operatorControl)
			throw new PalUnavailableError('This Pal computer does not support operator control.')
		return { lease, control: lease.operatorControl }
	}
	private async controlOperation<T>(
		palId: string,
		generation: number,
		transition: boolean,
		run: (control: PalComputerControl) => Promise<T>,
	): Promise<T> {
		const { lease, control } = this.ownedControl(palId, generation)
		// Reserve before invoking the provider; synchronous observers cannot admit a new task.
		const promise = Promise.resolve().then(async () => {
			if (this.closed || this.computer(palId) !== lease || !this.options.store.get(palId))
				throw new PalUnavailableError('This Pal computer control operation lost its ownership.')
			return run(control)
		})
		const operation = { transition, promise }
		this.controlOperations.set(palId, operation)
		try {
			return await promise
		} finally {
			if (this.controlOperations.get(palId) === operation) this.controlOperations.delete(palId)
		}
	}
	async takeOver(palId: string, generation: number): Promise<void> {
		return this.controlOperation(palId, generation, true, async (control) => {
			if (control.mode !== 'pal')
				throw new PalUnavailableError('This Pal computer is not under Pal control.')
			// A preview capture must never certify what a later Pal admission has observed.
			this.freshScreenRequired.add(palId)
			await control.takeOver()
			if (controlMode(control) !== 'operator')
				throw new PalUnavailableError('Operator control of this Pal computer was not confirmed.')
		})
	}
	async returnControl(palId: string, generation: number): Promise<void> {
		return this.controlOperation(palId, generation, true, async (control) => {
			if (control.mode !== 'operator')
				throw new PalUnavailableError('This Pal computer is not under operator control.')
			await control.returnControl()
			if (controlMode(control) !== 'pal')
				throw new PalUnavailableError('Pal control of this computer was not confirmed.')
		})
	}
	async executeOperatorInput(
		palId: string,
		generation: number,
		input: PalComputerInput,
	): Promise<ComputerUseResult> {
		const captured = captureInput(input)
		return this.controlOperation(palId, generation, false, async (control) => {
			if (control.mode !== 'operator')
				throw new PalUnavailableError('Take operator control before sending computer input.')
			return control.executeInput(captured)
		})
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
		// Publish shared ownership before invoking observers or the provider.
		const start = Promise.resolve().then(async () => {
			this.lifecycle.emit({ type: 'computer.starting', palId })
			let lease: PalEnvironmentLease | undefined
			try {
				lease = await provider.acquire({
					pal,
					conversationId: `computer:${pal.id}`,
					...(signal ? { signal } : {}),
				})
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
				this.lifecycle.emit({ type: 'computer.ready', palId, generation: lease.generation })
				return lease
			} catch (error) {
				try {
					await lease?.release()
				} catch (releaseError) {
					if (lease) this.computers.set(palId, lease)
					this.failures.set(
						palId,
						'A rejected Pal computer could not be released. Retry stopping it.',
					)
					this.lifecycle.emit({ type: 'computer.start-failed', palId, reason: 'cleanup-required' })
					throw new AggregateError(
						[error, releaseError],
						'Pal computer admission and cleanup failed.',
					)
				}
				this.lifecycle.emit({ type: 'computer.start-failed', palId, reason: 'unavailable' })
				throw error
			}
		})
		this.starting.set(palId, start)
		try {
			return await start
		} finally {
			if (this.starting.get(palId) === start) this.starting.delete(palId)
		}
	}
	async stopComputer(palId: string): Promise<void> {
		if (this.controlOperations.has(palId))
			throw new PalUnavailableError('Wait for this Pal computer control operation to finish.')
		if (this.stopping.has(palId))
			throw new PalUnavailableError('This Pal computer is already stopping.')
		if (this.controllers.has(palId))
			throw new PalUnavailableError('Stop this Pal’s active work before stopping its computer.')
		if (this.starting.has(palId))
			throw new PalUnavailableError('Wait for this Pal computer to finish starting.')
		const lease = this.computers.get(palId)
		if (!lease) return
		const identity =
			lease.palId === palId && Number.isSafeInteger(lease.generation) && lease.generation > 0
				? { generation: lease.generation }
				: {}
		this.stopping.add(palId)
		this.lifecycle.emit({ type: 'computer.stopping', palId, ...identity })
		try {
			await lease.release()
			if (this.computers.get(palId) === lease) this.computers.delete(palId)
			this.freshScreenRequired.delete(palId)
			this.failures.delete(palId)
			this.lifecycle.emit({ type: 'computer.stopped', palId, ...identity })
		} catch (error) {
			this.failures.set(palId, 'The Pal computer could not be stopped. Retry stopping it.')
			this.lifecycle.emit({ type: 'computer.stop-failed', palId, ...identity })
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
		if (
			this.controlOperations.has(current.id) ||
			(this.computers.get(current.id)?.operatorControl &&
				this.computers.get(current.id)?.operatorControl?.mode !== 'pal')
		)
			throw new PalUnavailableError('Return this Pal computer to Pal control before starting work.')
		if (this.controllers.has(current.id))
			throw new PalUnavailableError('This Pal computer is busy in another conversation.')
		const controller = {
			conversationId: request.conversationId,
			generation: undefined as number | undefined,
		}
		this.controllers.set(current.id, controller)
		try {
			const lease = await this.startComputer(current.id, request.signal)
			let released = false
			const assertActive = () => {
				request.signal?.throwIfAborted()
				if (
					released ||
					this.closed ||
					this.controllers.get(current.id) !== controller ||
					this.computers.get(current.id) !== lease
				)
					throw new PalUnavailableError('This Pal admission no longer owns its computer.')
				if (lease.sandbox.status !== 'ready' && lease.sandbox.status !== 'busy')
					throw new PalUnavailableError('This Pal computer retired during its work.')
				if (
					this.controlOperations.has(current.id) ||
					(lease.operatorControl && lease.operatorControl.mode !== 'pal')
				)
					throw new PalUnavailableError('This Pal admission does not have Pal computer control.')
				const latest = this.options.store.get(definition.id)
				if (!latest || latest.paused)
					throw new PalUnavailableError('This Pal is paused or unavailable.')
				if (latest.workspace !== definition.workspace)
					throw new PalUnavailableError('Pal workspace identity changed.')
			}
			assertActive()
			controller.generation = lease.generation
			this.lifecycle.emit({
				type: 'admission.acquired',
				palId: current.id,
				generation: lease.generation,
				conversationId: controller.conversationId,
			})
			return {
				definition,
				lease: this.freshScreenRequired.has(current.id)
					? {
							...lease,
							computerUseHost: freshAdmissionComputer(lease.computerUseHost, assertActive),
							release: () => lease.release(),
						}
					: lease,
				assertActive,
				release: async () => {
					if (released) return
					released = true
					if (this.controllers.get(current.id) === controller) {
						this.controllers.delete(current.id)
						this.lifecycle.emit({
							type: 'admission.released',
							palId: current.id,
							generation: lease.generation,
							conversationId: controller.conversationId,
							reason: 'released',
						})
					}
				},
			}
		} catch (error) {
			if (this.controllers.get(current.id) === controller) this.controllers.delete(current.id)
			throw error
		}
	}
	async close(): Promise<void> {
		if (this.closing) return this.closing
		this.closed = true
		const closing = (async () => {
			await Promise.allSettled(this.starting.values())
			await Promise.allSettled([...this.controlOperations.values()].map(({ promise }) => promise))
			for (const [palId, controller] of this.controllers) {
				if (controller.generation !== undefined)
					this.lifecycle.emit({
						type: 'admission.released',
						palId,
						generation: controller.generation,
						conversationId: controller.conversationId,
						reason: 'closed',
					})
			}
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
