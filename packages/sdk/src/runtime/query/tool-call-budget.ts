import type { TurnId } from '../../types/ids/index.js'
import type { SessionRecord } from '../../types/session/records.js'
import type { SessionEventDraft } from './events.js'

export function assertMaxToolCalls(limit: number | undefined): void {
	if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
		throw new RangeError('maxToolCalls must be a nonnegative safe integer.')
	}
}

/** A turn-owned admission ledger; durability belongs to the session log. */
export class ToolCallBudget {
	private used = 0
	private initialized?: Promise<void>
	private chain: Promise<void> = Promise.resolve()
	private failed: unknown

	constructor(
		private readonly limit: number,
		private readonly turnId: TurnId,
		private readonly emit: (event: SessionEventDraft) => Promise<void>,
		private readonly read?: () => Promise<readonly SessionRecord[]>,
	) {
		assertMaxToolCalls(limit)
	}

	private async initialize(): Promise<void> {
		// The session log is read strictly (every record chained to the one
		// before it), so it is complete; this turn's records are the ledger.
		const events = ((await this.read?.()) ?? []).filter((record) => record.turnId === this.turnId)
		if (events.length > 100_000)
			throw new Error('Tool-call budget recovery exceeds 100000 records.')
		let initialized = false
		for (const event of events) {
			if (event.type === 'tool_calls_admitted') {
				if (
					!Number.isSafeInteger(event.count) ||
					event.count < 0 ||
					!Number.isSafeInteger(event.used) ||
					event.used !== this.used + event.count ||
					!Number.isSafeInteger(event.limit) ||
					event.limit < event.used ||
					!['initialize', 'batch', 'nested', 'retry'].includes(event.kind) ||
					(event.kind === 'initialize'
						? initialized || event.count !== 0
						: !initialized || event.count === 0)
				)
					throw new Error('Invalid tool-call admission ledger.')
				initialized = true
				this.used = event.used
			} else if (
				!initialized &&
				(event.type === 'tool_executing' || event.type === 'tool_completed')
			) {
				throw new Error('Cannot establish tool-call usage for an earlier unbudgeted execution.')
			}
		}
		if (!initialized) {
			await this.emit({
				type: 'tool_calls_admitted',
				turnId: this.turnId,
				kind: 'initialize',
				count: 0,
				used: 0,
				limit: this.limit,
			})
		}
	}

	/** Reserve before work, never refund. A refused group consumes no new slots. */
	async admit(
		count: number,
		kind: 'batch' | 'nested' | 'retry',
		signal: AbortSignal,
	): Promise<string | undefined> {
		signal.throwIfAborted()
		const previous = this.chain
		let release!: () => void
		this.chain = new Promise<void>((resolve) => {
			release = resolve
		})
		try {
			await previous
			signal.throwIfAborted()
			if (this.failed !== undefined) throw this.failed
			this.initialized ??= this.initialize()
			await this.initialized
			signal.throwIfAborted()
			if (count > Math.max(0, this.limit - this.used)) {
				return `Tool-call budget exhausted: this ${kind} needs ${count} slots; ${Math.max(0, this.limit - this.used)} remain of maxToolCalls=${this.limit}. No calls in this admission were executed.`
			}
			if (count === 0) return undefined
			const used = this.used + count
			try {
				await this.emit({
					type: 'tool_calls_admitted',
					turnId: this.turnId,
					kind,
					count,
					used,
					limit: this.limit,
				})
			} catch (error) {
				// An uncertain write must not be retried as a fresh allowance.
				this.failed = error ?? new Error('Tool-call admission persistence failed.')
				throw this.failed
			}
			this.used = used
			signal.throwIfAborted()
			return undefined
		} finally {
			release()
		}
	}
}
