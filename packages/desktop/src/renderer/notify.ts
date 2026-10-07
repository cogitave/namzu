import { Toast } from '@base-ui/react/toast'
import type { ToastManager } from '@base-ui/react/toast'

export type ToastTone = 'neutral' | 'success' | 'warning' | 'error'

export interface NotifyOptions {
	/** One button on the toast, for a step the person can take back or follow up on. */
	action?: { label: string; onClick: () => void }
	tone?: ToastTone
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

	const show = (sink: ToastSink, item: Pending) => {
		const { id, text, options } = item
		const tone = options.tone ?? 'neutral'
		const action = options.action
		shownBy.set(id, sink)
		sink.add({
			id,
			title: text,
			type: tone,
			// Base UI announces `high` through an assertive live region.
			priority: tone === 'error' ? 'high' : 'low',
			timeout: options.timeoutMs ?? defaultTimeoutMs(tone, Boolean(action)),
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

	return {
		notify(text: string, options: NotifyOptions = {}): string {
			const id = `notice-${++counter}`
			const item = { id, text, options }
			const sink = target()
			if (sink) show(sink, item)
			else pending = [...pending, item].slice(-PENDING_LIMIT)
			return id
		},
		dismiss(id: string) {
			pending = pending.filter((item) => item.id !== id)
			shownBy.get(id)?.close(id)
			shownBy.delete(id)
		},
		/** A pane's manager joins; `focus` makes it the one new notices go to. */
		register(sink: ToastSink) {
			panes.add(sink)
			current ??= sink
			const waiting = pending
			pending = []
			for (const item of waiting) show(target() ?? sink, item)
			return {
				focus() {
					current = sink
				},
				dispose() {
					panes.delete(sink)
					for (const [id, owner] of shownBy) if (owner === sink) shownBy.delete(id)
					if (current === sink) current = [...panes].at(-1)
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
