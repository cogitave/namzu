import type { SessionEvent } from '@namzu/sdk'

/**
 * The desktop's feed of how full a conversation is and whether it is being
 * compacted. The shared protocol bridge carries neither on purpose, so the
 * desktop host says it itself, as one `namzu/` notification per session. Every
 * field except the session id is optional and absent means "the engine did not
 * say": a viewer shows nothing for it rather than a guess.
 */
export const USAGE_NOTIFICATION = 'namzu/session/usage'

/** At most one usage notification per session in this many milliseconds. */
export const USAGE_COALESCE_MS = 400

export interface UsageNotification {
	readonly sessionId: string
	/** Size of the conversation as the model sees it now, in tokens. */
	readonly contextTokens?: number
	/** The most the model accepts, in tokens. */
	readonly contextWindowTokens?: number
	/** Whether `contextTokens` was counted by the provider or estimated. */
	readonly contextMeasuredBy?: 'provider' | 'estimate'
	/** Cost so far in US dollars; present only when every token was priced. */
	readonly cost?: number
	/** `started` while a pass runs, `finished` when it ends (`failed` when it changed nothing). */
	readonly compaction?: 'started' | 'finished' | 'failed'
	readonly tokensBefore?: number
	readonly tokensAfter?: number
}

export interface UsageFeedOptions {
	readonly notify: (method: string, params: Record<string, unknown>) => void
	/** Milliseconds on any steady clock. Injected so tests never wait. */
	readonly now: () => number
	/** Runs `run` after `ms`; returns a function that cancels it. */
	readonly schedule: (run: () => void, ms: number) => () => void
	readonly intervalMs?: number
}

export interface UsageFeed {
	observe(sessionId: string, event: SessionEvent): void
	/** Drop everything pending; nothing is sent afterwards. */
	close(): void
}

type Writable<T> = { -readonly [K in keyof T]: T[K] }

interface Pending {
	snapshot: Omit<UsageNotification, 'sessionId' | 'compaction' | 'tokensBefore' | 'tokensAfter'>
	lastSentAt: number | undefined
	cancel: (() => void) | undefined
	dirty: boolean
}

const finite = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Absent fields stay absent on the wire. */
const defined = <T extends object>(value: T): T =>
	Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T

export function createUsageFeed(options: UsageFeedOptions): UsageFeed {
	const interval = options.intervalMs ?? USAGE_COALESCE_MS
	const sessions = new Map<string, Pending>()
	let closed = false
	const entry = (sessionId: string): Pending => {
		let found = sessions.get(sessionId)
		if (!found) {
			found = { snapshot: {}, lastSentAt: undefined, cancel: undefined, dirty: false }
			sessions.set(sessionId, found)
		}
		return found
	}
	const send = (sessionId: string, pending: Pending, extra: Partial<UsageNotification> = {}) => {
		pending.cancel?.()
		pending.cancel = undefined
		pending.dirty = false
		pending.lastSentAt = options.now()
		const body: UsageNotification = { sessionId, ...defined(pending.snapshot), ...extra }
		try {
			options.notify(USAGE_NOTIFICATION, { ...body })
		} catch {
			/* The feed is a convenience; a closed stream must not fail the turn. */
		}
	}
	const usage = (sessionId: string, pending: Pending) => {
		pending.dirty = true
		const since =
			pending.lastSentAt === undefined
				? Number.POSITIVE_INFINITY
				: options.now() - pending.lastSentAt
		if (since >= interval) {
			send(sessionId, pending)
			return
		}
		if (pending.cancel) return
		pending.cancel = options.schedule(() => {
			pending.cancel = undefined
			if (!closed && pending.dirty) send(sessionId, pending)
		}, interval - since)
	}
	return {
		observe(sessionId, event) {
			if (closed) return
			if (event.type === 'token_usage_updated') {
				const pending = entry(sessionId)
				const snapshot: Writable<Pending['snapshot']> = { ...pending.snapshot }
				if (finite(event.contextTokens)) snapshot.contextTokens = event.contextTokens
				if (finite(event.contextWindowTokens) && event.contextWindowTokens > 0)
					snapshot.contextWindowTokens = event.contextWindowTokens
				if (event.contextMeasuredBy) snapshot.contextMeasuredBy = event.contextMeasuredBy
				// A cost is shown only when every token was priced; otherwise the old figure goes too.
				if (
					finite(event.cost?.totalCost) &&
					event.cost.totalCost > 0 &&
					(event.cost.unpricedTokens ?? 0) === 0
				)
					snapshot.cost = event.cost.totalCost
				else snapshot.cost = undefined
				pending.snapshot = snapshot
				usage(sessionId, pending)
			} else if (event.type === 'compaction_started') {
				const pending = entry(sessionId)
				send(sessionId, pending, {
					compaction: 'started',
					tokensBefore: event.tokensBefore,
					...(finite(event.contextWindowTokens) && event.contextWindowTokens > 0
						? { contextWindowTokens: event.contextWindowTokens }
						: {}),
				})
			} else if (event.type === 'compaction_completed') {
				const pending = entry(sessionId)
				if (finite(event.tokensAfter))
					pending.snapshot = { ...pending.snapshot, contextTokens: event.tokensAfter }
				send(sessionId, pending, {
					compaction: 'finished',
					tokensBefore: event.tokensBefore,
					tokensAfter: event.tokensAfter,
				})
			} else if (event.type === 'compaction_tool_results_cleared' && event.reliefWasEnough) {
				send(sessionId, entry(sessionId), { compaction: 'finished' })
			} else if (event.type === 'compaction_failed') {
				send(sessionId, entry(sessionId), { compaction: 'failed' })
			}
		},
		close() {
			closed = true
			for (const pending of sessions.values()) pending.cancel?.()
			sessions.clear()
		},
	}
}
