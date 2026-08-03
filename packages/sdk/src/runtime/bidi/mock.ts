import type { BidiEvent, BidiInput, BidiProvider, BidiSession } from '../../types/bidi/index.js'

/**
 * A duplex driver you script.
 *
 * The loop it exercises has no real service behind it yet, and that is
 * the ordinary situation for a driver contract in this codebase rather
 * than a reason not to have one: the turn-based path is developed and
 * regression-tested against a scripted model too. What this makes
 * testable is the part that is genuinely namzu's — running tools without
 * stalling the stream, and abandoning their answers when the human speaks
 * over the model.
 */

export interface MockBidiScript {
	/** Events the far side emits, in order, as the test releases them. */
	readonly events?: readonly BidiEvent[]
	/** Emit everything immediately instead of waiting to be stepped. */
	readonly auto?: boolean
}

export interface MockBidiSession extends BidiSession {
	/** Release the next scripted event. */
	step(): void
	/** Emit an event the script did not contain. */
	push(event: BidiEvent): void
	/** Everything the loop sent back, in order. */
	readonly sent: ReadonlyArray<BidiInput | { toolResult: string; output: string; isError: boolean }>
}

export function createMockBidiProvider(script: MockBidiScript = {}): BidiProvider & {
	session(): MockBidiSession | undefined
} {
	let current: MockBidiSession | undefined

	return {
		id: 'mock-bidi',
		session: () => current,
		connect: async () => {
			const pending = [...(script.events ?? [])]
			const queue: BidiEvent[] = []
			let wake: (() => void) | undefined
			let done = false
			const sent: Array<BidiInput | { toolResult: string; output: string; isError: boolean }> = []

			const emit = (event: BidiEvent) => {
				queue.push(event)
				if (event.type === 'closed') done = true
				wake?.()
			}

			if (script.auto) for (const event of pending.splice(0)) emit(event)

			const session: MockBidiSession = {
				sent,
				step: () => {
					const next = pending.shift()
					if (next) emit(next)
				},
				push: emit,
				send: async (input) => {
					sent.push(input)
				},
				sendToolResult: async (id, output, isError) => {
					sent.push({ toolResult: id, output, isError: isError ?? false })
				},
				events: async function* () {
					while (true) {
						while (queue.length > 0) {
							const next = queue.shift()
							if (next) yield next
						}
						if (done) return
						await new Promise<void>((resolve) => {
							wake = resolve
						})
						wake = undefined
					}
				},
				close: async () => {
					done = true
					wake?.()
				},
			}

			current = session
			return session
		},
	}
}
