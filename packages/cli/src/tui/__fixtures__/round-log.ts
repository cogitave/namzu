/**
 * A transcript of what the round machinery handed to the session.
 *
 * The golden round tests record every `send` the App makes, in order, with the
 * facts that decide whether the model was asked the same thing: who started
 * the round (typed text, an admitted goal round, a wake notice), the text of
 * the last message, the host context and the goal round it carried. A refactor
 * of how rounds are admitted must leave these lines byte for byte unchanged.
 * Nothing here reads a clock or counts frames, so the lines depend only on the
 * order of events.
 */

import type { Message } from '@namzu/sdk'

import type { SendOptions } from '../agent.js'

export interface RoundLogEntry {
	readonly index: number
	/** `goal-round`, a `runtime-context` kind, or `typed` for a person's message. */
	readonly origin: string
	readonly goalRound?: number
	readonly text: string
	readonly hostContext: string
}

export class RoundLog {
	readonly entries: RoundLogEntry[] = []

	record(messages: readonly Message[], options: SendOptions | undefined): void {
		const last = messages.at(-1) as
			| (Message & { source?: { type?: string; kind?: string } })
			| undefined
		const source = last?.source
		const origin = options?.goalRound
			? 'goal-round'
			: source?.type === 'runtime-context'
				? `runtime-context:${source.kind ?? ''}`
				: (source?.type ?? 'typed')
		this.entries.push({
			index: this.entries.length,
			origin,
			...(options?.goalRound ? { goalRound: options.goalRound.round } : {}),
			text: String(last?.content ?? ''),
			hostContext: options?.hostContext?.().join('\n\n') ?? '',
		})
	}

	/** One stable line per send; the text is cut at its first line so a long envelope stays readable. */
	lines(): string[] {
		return this.entries.map((entry) => {
			// The envelope tag carries a random nonce; everything else is stable.
			const text = entry.text.replace(/system-event-[0-9a-f]+/g, 'system-event-<nonce>')
			const rows = text.split('\n')
			const first = rows[0] ?? ''
			const round = entry.goalRound === undefined ? '' : ` round=${entry.goalRound}`
			const ctx = entry.hostContext === '' ? '' : ` ctx=${JSON.stringify(entry.hostContext)}`
			return `#${entry.index} ${entry.origin}${round} rows=${rows.length} ${JSON.stringify(first)}${ctx}`
		})
	}

	clear(): void {
		this.entries.length = 0
	}
}
