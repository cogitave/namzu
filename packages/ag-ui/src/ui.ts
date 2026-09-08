import { type BaseEvent, EventType, type Message, MessageSchema } from '@ag-ui/core'
import jsonPatch, { type Operation } from 'fast-json-patch'

export interface AGUIRunUIOptions {
	/** Maximum queued application events. Defaults to 128. */
	readonly maxPendingEvents?: number
	/** Maximum encoded bytes in one state or application event. Defaults to 1 MiB. */
	readonly maxEventBytes?: number
}

/** Request-scoped application state; never kernel configuration or model instructions. */
export class AGUIRunUI {
	private current: unknown
	private readonly events: BaseEvent[] = []
	private notifyListener?: () => void
	private closed = false
	private messagesSealed = false
	private readonly maxPending: number
	private readonly maxBytes: number

	constructor(initialState: unknown, options: AGUIRunUIOptions = {}) {
		this.maxPending = positiveLimit(options.maxPendingEvents, 128, 'maxPendingEvents')
		this.maxBytes = positiveLimit(options.maxEventBytes, 1_048_576, 'maxEventBytes')
		this.current = this.copy(initialState ?? null)
	}

	/** A detached JSON snapshot. Mutating it does not publish a state change. */
	get state(): unknown {
		return this.copy(this.current)
	}

	/** Publish host-admitted display history before the query starts. Does not change model input. */
	setInitialMessages(messages: readonly Message[]): void {
		if (this.messagesSealed)
			throw new Error('Initial messages must be supplied inside createQuery before it returns')
		const parsed = MessageSchema.array().safeParse(this.copy(messages))
		if (!parsed.success) throw new TypeError('Initial messages must match the AG-UI message schema')
		const ids = new Set<string>()
		for (const message of parsed.data) {
			if (!message.id.trim() || ids.has(message.id))
				throw new TypeError('Initial messages require nonempty unique IDs')
			ids.add(message.id)
		}
		this.enqueue({ type: EventType.MESSAGES_SNAPSHOT, messages: parsed.data })
	}

	/** @internal Freeze display history before native message lifecycles begin. */
	sealInitialMessages(): void {
		this.messagesSealed = true
	}

	setState(value: unknown): void {
		const snapshot = this.copy(value)
		this.enqueue({ type: EventType.STATE_SNAPSHOT, snapshot })
		this.current = snapshot
	}

	/** Apply an RFC 6902 patch atomically; invalid patches leave state unchanged. */
	patchState(operations: readonly Operation[]): void {
		const delta = this.copy(operations) as Operation[]
		const next = jsonPatch.applyPatch(this.copy(this.current), delta, true, false, true).newDocument
		const state = this.copy(next)
		this.enqueue({ type: EventType.STATE_DELTA, delta })
		this.current = state
	}

	custom(name: string, value: unknown): void {
		if (!name.trim()) throw new TypeError('An AG-UI custom event needs a name')
		this.enqueue({ type: EventType.CUSTOM, name, value: this.copy(value) })
	}

	/** @internal Adapter-owned delivery; application code uses the methods above. */
	drain(): BaseEvent[] {
		return this.events.splice(0)
	}

	/** @internal One adapter observer; no promise reactions accumulate while a source is quiet. */
	onEvent(listener: () => void): () => void {
		if (this.notifyListener) throw new Error('AG-UI application events already have an owner')
		this.notifyListener = listener
		return () => {
			this.notifyListener = undefined
		}
	}

	/** @internal Close the capability when its owning request settles. */
	close(): void {
		this.closed = true
		this.events.length = 0
		this.notify()
	}

	private enqueue(event: BaseEvent): void {
		if (this.closed) throw new Error('This AG-UI run has ended')
		if (this.events.length >= this.maxPending)
			throw new RangeError('AG-UI application event queue is full')
		this.events.push(this.copy(event) as BaseEvent)
		this.notify()
	}

	private notify(): void {
		this.notifyListener?.()
	}

	private copy(value: unknown): unknown {
		const encoded = JSON.stringify(value, (_key, item: unknown) => {
			if (
				item === undefined ||
				typeof item === 'function' ||
				typeof item === 'symbol' ||
				(typeof item === 'number' && !Number.isFinite(item))
			)
				throw new TypeError('AG-UI state and events must contain only JSON values')
			return item
		})
		if (encoded === undefined) throw new TypeError('AG-UI state and events must be JSON values')
		if (Buffer.byteLength(encoded) > this.maxBytes)
			throw new RangeError('AG-UI state or event exceeds maxEventBytes')
		return JSON.parse(encoded)
	}
}

export function positiveLimit(value: number | undefined, fallback: number, name: string): number {
	const limit = value ?? fallback
	if (!Number.isSafeInteger(limit) || limit < 1)
		throw new RangeError(`${name} must be a positive safe integer`)
	return limit
}
