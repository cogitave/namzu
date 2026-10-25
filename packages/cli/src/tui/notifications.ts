/**
 * The footer's notice slot: a queue of short, passing messages of which one at
 * a time is on screen, at the right end of the footer row.
 *
 * Pure: `reduce` takes the state and an action and returns the next state plus
 * what the owner of the timer has to do, so the rules can be tested without a
 * clock. `useNotifications.ts` runs the timer.
 *
 * Rules:
 * - Priority is `immediate` < `high` < `medium` < `low`; among equals the
 *   earlier arrival goes first.
 * - An `immediate` notice shows at once. The notice it covers returns after it,
 *   unless that one was `immediate` itself (then only when it asks to via
 *   `requeueOnPreempt`) or the new one `invalidates` it.
 * - Any other notice waits. While one is showing nothing else is promoted, so a
 *   `high` notice does not displace a `medium` one that is up.
 * - A key that is already showing or waiting is ignored, unless the new notice
 *   brings a `fold`, which merges the two and, for the showing one, restarts
 *   its timer.
 * - A notice stays `DEFAULT_NOTICE_MS` unless it names its own time.
 */

export type NoticePriority = 'immediate' | 'high' | 'medium' | 'low'

/** How a notice is drawn; none given means dim. */
export type NoticeTone = 'dim' | 'warn' | 'error'

export interface Notice {
	/** Identity: the same key is the same notice. */
	readonly key: string
	readonly text: string
	readonly tone?: NoticeTone
	readonly priority: NoticePriority
	/** How long it stays up once shown; `DEFAULT_NOTICE_MS` when omitted. */
	readonly timeoutMs?: number
	/** Keys this notice makes pointless: they are dropped, showing or waiting. */
	readonly invalidates?: readonly string[]
	/** Merge a newer notice of the same key into the older one. */
	readonly fold?: (older: Notice, newer: Notice) => Notice
	/** An `immediate` notice that is covered by another `immediate` one comes back afterwards. */
	readonly requeueOnPreempt?: boolean
}

export const DEFAULT_NOTICE_MS = 8_000

const RANK: Readonly<Record<NoticePriority, number>> = { immediate: 0, high: 1, medium: 2, low: 3 }

export interface NoticeState {
	readonly current: Notice | null
	readonly queue: readonly Notice[]
}

export const EMPTY_NOTICES: NoticeState = { current: null, queue: [] }

export type NoticeAction =
	| { readonly type: 'add'; readonly notice: Notice }
	| { readonly type: 'remove'; readonly key: string }
	| { readonly type: 'expire'; readonly key: string }

/** What the timer's owner does next: run a new timer for `key`, or stop the running one. */
export type NoticeTimer =
	| { readonly kind: 'start'; readonly key: string; readonly ms: number }
	| { readonly kind: 'cancel' }

export interface NoticeStep {
	readonly state: NoticeState
	readonly timer?: NoticeTimer
}

const lifetime = (notice: Notice): number => notice.timeoutMs ?? DEFAULT_NOTICE_MS

function show(queue: readonly Notice[], notice: Notice): NoticeStep {
	return {
		state: { current: notice, queue },
		timer: { kind: 'start', key: notice.key, ms: lifetime(notice) },
	}
}

/** Promote the best waiting notice when nothing is showing. */
function promote(state: NoticeState, cancelled: boolean): NoticeStep {
	if (state.current !== null) return { state }
	let best = -1
	state.queue.forEach((notice, index) => {
		if (best < 0 || RANK[notice.priority] < RANK[(state.queue[best] as Notice).priority])
			best = index
	})
	if (best < 0) return cancelled ? { state, timer: { kind: 'cancel' } } : { state }
	const next = state.queue[best] as Notice
	return show(
		state.queue.filter((_, index) => index !== best),
		next,
	)
}

export function reduce(state: NoticeState, action: NoticeAction): NoticeStep {
	switch (action.type) {
		case 'add':
			return add(state, action.notice)
		case 'remove': {
			const wasCurrent = state.current?.key === action.key
			return promote(
				{
					current: wasCurrent ? null : state.current,
					queue: state.queue.filter((notice) => notice.key !== action.key),
				},
				wasCurrent,
			)
		}
		case 'expire':
			// A timer that fires for a notice already gone changes nothing.
			if (state.current?.key !== action.key) return { state }
			return promote({ current: null, queue: state.queue }, false)
	}
}

function add(state: NoticeState, notice: Notice): NoticeStep {
	const invalidated = (key: string): boolean => notice.invalidates?.includes(key) === true
	if (notice.priority === 'immediate') {
		const old = state.current
		const queue = state.queue.filter((waiting) => !invalidated(waiting.key))
		// Deliberate: the same key being shown again never queues itself behind itself.
		const comesBack =
			old !== null &&
			old.key !== notice.key &&
			(old.priority !== 'immediate' || old.requeueOnPreempt === true) &&
			!invalidated(old.key)
		return show(comesBack && old !== null ? [old, ...queue] : queue, notice)
	}

	let { current } = state
	let queue = state.queue
	let timer: NoticeTimer | undefined
	if (current?.key === notice.key) {
		if (notice.fold) {
			current = notice.fold(current, notice)
			timer = { kind: 'start', key: current.key, ms: lifetime(current) }
		}
	} else if (queue.some((waiting) => waiting.key === notice.key)) {
		if (notice.fold) {
			const fold = notice.fold
			queue = queue.map((waiting) => (waiting.key === notice.key ? fold(waiting, notice) : waiting))
		}
	} else {
		queue = [...queue.filter((waiting) => !invalidated(waiting.key)), notice]
	}
	if (current !== null && invalidated(current.key)) {
		current = null
		timer = { kind: 'cancel' }
	}
	const promoted = promote({ current, queue }, false)
	return {
		state: promoted.state,
		...((promoted.timer ?? timer) ? { timer: promoted.timer ?? timer } : {}),
	}
}
