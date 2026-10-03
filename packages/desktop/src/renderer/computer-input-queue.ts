import type { PalComputerInput } from '../shared/protocol.js'

export interface ComputerInputOwner {
	readonly id: string
	readonly generation: string
	readonly navigation: number
}

const maxTextBytes = 32_768
const encoder = new TextEncoder()

interface Waiter {
	resolve: () => void
	reject: (error: unknown) => void
}
interface Batch {
	action: PalComputerInput
	owner: Readonly<ComputerInputOwner>
	waiters: Waiter[]
}

function sameOwner(left: ComputerInputOwner, right: ComputerInputOwner): boolean {
	return (
		left.id === right.id &&
		left.generation === right.generation &&
		left.navigation === right.navigation
	)
}

function freezeAction(action: PalComputerInput): PalComputerInput {
	const copy = structuredClone(action)
	for (const value of Object.values(copy))
		if (value && typeof value === 'object') Object.freeze(value)
	return Object.freeze(copy)
}

function textChunks(text: string): string[] {
	if (encoder.encode(text).byteLength <= maxTextBytes) return [text]
	const chunks: string[] = []
	let chunk = ''
	let bytes = 0
	for (const character of text) {
		const size = encoder.encode(character).byteLength
		if (bytes + size > maxTextBytes) {
			chunks.push(chunk)
			chunk = ''
			bytes = 0
		}
		chunk += character
		bytes += size
	}
	if (chunk) chunks.push(chunk)
	return chunks
}

/**
 * Finite renderer queue. The executor must recheck the captured owner immediately
 * before each host call; a prior batch's result never authorizes the next one.
 */
export class ComputerInputQueue {
	private readonly batches: Batch[] = []
	private readonly idleWaiters: (() => void)[] = []
	private running = false
	private scheduled = false

	constructor(
		private readonly execute: (
			action: PalComputerInput,
			owner: Readonly<ComputerInputOwner>,
		) => Promise<void>,
	) {}

	enqueue(action: PalComputerInput, owner: ComputerInputOwner): Promise<void> {
		const captured = Object.freeze({
			id: owner.id,
			generation: owner.generation,
			navigation: owner.navigation,
		})
		const actions =
			action.type === 'type_text'
				? textChunks(action.text).map((text): PalComputerInput => ({ type: 'type_text', text }))
				: [freezeAction(action)]
		const accepted = actions.map(
			(next) =>
				new Promise<void>((resolve, reject) => {
					const tail = this.batches.at(-1)
					const waiter = { resolve, reject }
					if (tail && sameOwner(tail.owner, captured)) {
						if (
							tail.action.type === 'type_text' &&
							next.type === 'type_text' &&
							encoder.encode(tail.action.text).byteLength + encoder.encode(next.text).byteLength <=
								maxTextBytes
						) {
							tail.action = Object.freeze({
								type: 'type_text',
								text: tail.action.text + next.text,
							})
							tail.waiters.push(waiter)
							return
						}
						if (tail.action.type === 'mouse_move' && next.type === 'mouse_move') {
							tail.action = next
							tail.waiters.push(waiter)
							return
						}
					}
					this.batches.push({ action: Object.freeze(next), owner: captured, waiters: [waiter] })
				}),
		)
		this.schedule()
		return Promise.all(accepted).then(() => {})
	}

	/** Wait for all queued/in-flight calls to settle; each enqueue reports its own failure. */
	flush(): Promise<void> {
		if (!this.running && this.batches.length === 0) return Promise.resolve()
		this.schedule()
		return new Promise((resolve) => this.idleWaiters.push(resolve))
	}

	private schedule(): void {
		if (this.running || this.scheduled) return
		this.scheduled = true
		queueMicrotask(() => {
			this.scheduled = false
			void this.drain()
		})
	}

	private async drain(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			for (let batch = this.batches.shift(); batch; batch = this.batches.shift()) {
				try {
					await this.execute(batch.action, batch.owner)
					for (const waiter of batch.waiters) waiter.resolve()
				} catch (error) {
					for (const waiter of batch.waiters) waiter.reject(error)
				}
			}
		} finally {
			this.running = false
			for (const resolve of this.idleWaiters.splice(0)) resolve()
		}
	}
}
