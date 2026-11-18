import type { ContextDetail, ContextReport } from '../shared/context-protocol.js'

export const CONTEXT_REFRESH_MS = 400

export interface ContextRead {
	report?: ContextReport
	/** The engine has not counted yet, or cannot say. */
	empty?: true
	error?: true
	loading: boolean
}

export interface ContextReaderOptions {
	ask: (detail: ContextDetail) => Promise<ContextReport | null>
	publish: (read: ContextRead) => void
	/** Runs `run` after `ms`; returns a function that cancels it. Injected so tests never wait. */
	schedule: (run: () => void, ms: number) => () => void
}

/**
 * Asks the engine where the window goes while the panel is open: once when it opens (with the
 * lists), then again after each usage notice, at most once every 400 ms. Only the newest answer
 * counts, and an answer that fails keeps what is already on screen.
 */
export class ContextReader {
	private latest = 0
	private isOpen = false
	private cancel: (() => void) | undefined
	private current: ContextRead = { loading: false }
	private lists: ContextReport['lists']
	constructor(private readonly options: ContextReaderOptions) {}
	open(): void {
		this.isOpen = true
		this.request('full')
	}
	/** A usage notice arrived. */
	usageChanged(): void {
		if (!this.isOpen || this.cancel) return
		this.cancel = this.options.schedule(() => {
			this.cancel = undefined
			if (this.isOpen) this.request('summary')
		}, CONTEXT_REFRESH_MS)
	}
	close(): void {
		this.isOpen = false
		this.latest++
		this.cancel?.()
		this.cancel = undefined
	}
	private request(detail: ContextDetail): void {
		const mine = ++this.latest
		this.set({ ...this.current, loading: true })
		this.options.ask(detail).then(
			(report) => {
				if (this.latest !== mine || !this.isOpen) return
				if (!report) {
					this.set({ loading: false, empty: true })
					return
				}
				if (report.lists) this.lists = report.lists
				const merged = report.lists || !this.lists ? report : { ...report, lists: this.lists }
				this.set({ loading: false, report: merged })
			},
			() => {
				if (this.latest !== mine || !this.isOpen) return
				const { report } = this.current
				this.set({ loading: false, ...(report ? { report } : { error: true }) })
			},
		)
	}
	private set(next: ContextRead): void {
		this.current = next
		this.options.publish(next)
	}
}
