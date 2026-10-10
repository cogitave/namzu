import { Toast } from '@base-ui/react/toast'
import type { ToastManager } from '@base-ui/react/toast'

export type ToastTone = 'neutral' | 'success' | 'warning' | 'error'

export interface NotifyOptions {
	/** One button on the toast, for a step the person can take back or follow up on. */
	action?: { label: string; onClick: () => void }
	tone?: ToastTone
	/** Text for the hover tooltip, e.g. the full path a sentence shortened. */
	tooltip?: string
	/** How long the toast stays before it leaves; 0 keeps it until it is dismissed. */
	timeoutMs?: number
}

/** The two calls a pane's toast manager has to answer. */
export interface ToastSink {
	add(options: {
		id: string
		title: string
		type: ToastTone
		priority: 'low' | 'high'
		timeout: number
		actionProps?: { children: string; onClick: () => void }
		data?: { tooltip?: string }
		/** Called when the toast starts to leave, by timeout, dismissal or an action. */
		onClose?: () => void
	}): string
	close(id?: string): void
}

const TIMEOUT_MS = { plain: 4000, action: 8000, warning: 6000, error: 8000 }
// A notice sent before any pane has mounted waits here, newest last; a flood is capped.
const PENDING_LIMIT = 5

export function defaultTimeoutMs(tone: ToastTone, hasAction: boolean): number {
	if (tone === 'error') return TIMEOUT_MS.error
	if (hasAction) return TIMEOUT_MS.action
	return tone === 'warning' ? TIMEOUT_MS.warning : TIMEOUT_MS.plain
}

interface Pending {
	id: string
	text: string
	options: NotifyOptions
}

/**
 * Routes notices from anywhere (event handlers, IPC callbacks, plain modules) to the toast
 * viewport of the pane that was focused last. Each pane of a window owns its own manager, so
 * a split window shows a notice once, beside the conversation it concerns.
 */
export function createToastHub() {
	const panes = new Set<ToastSink>()
	const shownBy = new Map<string, ToastSink>()
	let current: ToastSink | undefined
	let pending: Pending[] = []
	let counter = 0

	// What is on screen now, and what waits for it to leave. An error the person has not seen
	// for its full time is never closed by a newer notice: the newer one waits its turn. Errors
	// wait ahead of everything else; of the others only the newest waits.
	let active: { id: string; text: string; tone: ToastTone; sink: ToastSink } | undefined
	let waiting: Pending[] = []

	const toneOf = (item: Pending): ToastTone => item.options.tone ?? 'neutral'

	const enqueue = (item: Pending) => {
		if (waiting.some((other) => other.text === item.text && toneOf(other) === toneOf(item))) return
		const errors = waiting.filter((other) => toneOf(other) === 'error')
		const others = waiting.filter((other) => toneOf(other) !== 'error')
		waiting = toneOf(item) === 'error' ? [...errors, item, ...others] : [...errors, item]
	}

	const showNext = () => {
		const next = waiting.shift()
		const sink = target()
		if (next && sink) show(sink, next)
	}

	const show = (sink: ToastSink, item: Pending) => {
		const { id, text, options } = item
		const tone = toneOf(item)
		const action = options.action
		// One notice at a time: a new one takes the place of an earlier one that is not an error.
		const earlier = active
		active = { id, text, tone, sink }
		if (earlier) {
			earlier.sink.close(earlier.id)
			shownBy.delete(earlier.id)
		}
		shownBy.set(id, sink)
		sink.add({
			id,
			title: text,
			type: tone,
			// Base UI announces `high` through an assertive live region.
			priority: tone === 'error' ? 'high' : 'low',
			timeout: options.timeoutMs ?? defaultTimeoutMs(tone, Boolean(action)),
			onClose: () => {
				shownBy.delete(id)
				if (active?.id !== id) return
				active = undefined
				showNext()
			},
			...(options.tooltip ? { data: { tooltip: options.tooltip } } : {}),
			...(action
				? {
						actionProps: {
							children: action.label,
							onClick: () => {
								try {
									action.onClick()
								} finally {
									sink.close(id)
								}
							},
						},
					}
				: {}),
		})
	}

	const target = () => current ?? [...panes].at(-1)

	/** Show a notice now, or hold it behind an error that is still on screen. Returns the id it answers to. */
	const deliver = (sink: ToastSink, item: Pending): string => {
		if (!active) {
			show(sink, item)
			return item.id
		}
		// The same words already on screen or waiting are one notice, not two.
		if (active.text === item.text && active.tone === toneOf(item)) return active.id
		if (active.tone === 'error') enqueue(item)
		else {
			// A newer notice takes the place of an older one that is not an error.
			waiting = waiting.filter((other) => toneOf(other) === 'error')
			show(sink, item)
		}
		return item.id
	}

	return {
		notify(text: string, options: NotifyOptions = {}): string {
			const id = `notice-${++counter}`
			const item = { id, text, options }
			const sink = target()
			if (sink) return deliver(sink, item)
			pending = [...pending, item].slice(-PENDING_LIMIT)
			return id
		},
		dismiss(id: string) {
			pending = pending.filter((item) => item.id !== id)
			waiting = waiting.filter((item) => item.id !== id)
			shownBy.get(id)?.close(id)
			shownBy.delete(id)
		},
		/** A pane's manager joins; `focus` makes it the one new notices go to. */
		register(sink: ToastSink) {
			panes.add(sink)
			current ??= sink
			const early = pending
			pending = []
			// Notices sent before any pane existed go through the same queue: an early error is not
			// closed unseen by the notice sent after it.
			for (const item of early) deliver(target() ?? sink, item)
			return {
				focus() {
					current = sink
				},
				dispose() {
					panes.delete(sink)
					for (const [id, owner] of shownBy) if (owner === sink) shownBy.delete(id)
					if (current === sink) current = [...panes].at(-1)
					if (active?.sink === sink) {
						active = undefined
						showNext()
					}
				},
			}
		},
	}
}

export const toastHub = createToastHub()
export const notify = toastHub.notify
export const dismissNotice = toastHub.dismiss

export function createPaneToastManager(): ToastManager {
	return Toast.createToastManager()
}
