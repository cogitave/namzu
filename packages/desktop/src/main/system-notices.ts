import { FINISHED_NOTICE_AFTER_MS } from '../shared/settings-protocol.js'

export type NoticeKind = 'needs-you' | 'finished' | 'failed'

/** What the system is asked to show. Nothing here ever comes from a conversation. */
export interface NoticePayload {
	/** The project's name, or "Namzu" for several conversations at once. */
	title: string
	/** One of the fixed sentences below. */
	body: string
	silent: boolean
}

export interface NoticeSettings {
	needsYou: boolean
	failed: boolean
	finished: boolean
	sound: boolean
}

export interface NoticeHost {
	/** The platform can show notifications; when it cannot, the icon badge is all there is. */
	supported(): boolean
	/** Some Namzu window has focus. */
	windowFocused(): boolean
	/** Shows one notification; `onClick` runs when the person clicks it. */
	show(payload: NoticePayload, onClick: () => void): { close(): void } | undefined
	now(): number
	/** Runs `run` after `ms`; returns a cancel. */
	schedule(ms: number, run: () => void): () => void
	/** How long events fold into one notification; defaults to `FOLD_MS`. */
	foldMs?(): number
	/** A turn must run at least this long to be worth a "finished" notification; defaults to `FINISHED_NOTICE_AFTER_MS` (a turn that ran exactly that long counts). */
	finishedAfterMs?(): number
	/** Read on every event: the settings can change while the app runs. */
	settings(): NoticeSettings
	/** The name of the project a conversation belongs to. */
	projectName(conversationId: string): string | undefined
	/** Focus a window and show that conversation. */
	open(conversationId: string): void
}

/** The only sentences a notification body can hold. */
export const NOTICE_SENTENCES: Record<NoticeKind, string> = {
	'needs-you': 'A conversation needs your answer',
	finished: 'Finished',
	failed: 'Stopped with an error',
}

/** Events arriving within this long of the first one are shown as one notification. */
export const FOLD_MS = 3000

const GROUP_SENTENCES: Record<NoticeKind, (count: number) => string> = {
	'needs-you': (count) => `${count} conversations need your answer`,
	finished: (count) => `${count} conversations finished`,
	failed: (count) => `${count} conversations stopped with an error`,
}

const FALLBACK_TITLE = 'Namzu'

/**
 * A system notification for the three moments that matter while the person is somewhere else: a
 * conversation needs an answer, a turn finished, a turn stopped with an error. It shows only while
 * no Namzu window is focused, says the project's name and one fixed sentence (never conversation
 * text, a file name, a command or anything a model wrote), shows a conversation at most once per
 * kind until the person comes back, and folds events that arrive close together into one. It uses
 * the platform's own notification, so the system's do-not-disturb applies. Pure: no Electron, no
 * real clock; the host is injected.
 */
export class SystemNotices {
	private waiting = new Set<string>()
	private started = new Map<string, number>()
	private batch = new Map<NoticeKind, string[]>()
	private cancelFold: (() => void) | undefined
	private shown = new Set<string>()
	private open: { close(): void }[] = []

	constructor(private readonly host: NoticeHost) {}

	/**
	 * The conversations waiting on the person changed. Only a conversation that was not waiting
	 * before is an event; one that was already waiting when the window lost focus is not.
	 */
	needsYou(ids: readonly string[]): void {
		const before = this.waiting
		this.waiting = new Set(ids)
		for (const id of this.waiting) if (!before.has(id)) this.raise('needs-you', id)
	}

	/** A turn began; the clock starts for the "finished" threshold. */
	turnStarted(id: string): void {
		this.started.set(id, this.host.now())
	}

	/**
	 * A turn ended. `outcome` is what the app knows, not what the model said: `finished` for a
	 * normal end, `failed` for an error, `other` for a stop the person asked for. A Pal's turn
	 * is background work and never notifies when it ends.
	 */
	turnEnded(id: string, outcome: 'finished' | 'failed' | 'other', pal: boolean): void {
		const began = this.started.get(id)
		this.started.delete(id)
		if (pal || outcome === 'other') return
		if (outcome === 'finished') {
			if (
				began === undefined ||
				this.host.now() - began < (this.host.finishedAfterMs?.() ?? FINISHED_NOTICE_AFTER_MS)
			)
				return
			this.raise('finished', id)
		} else this.raise('failed', id)
	}

	/** A conversation is gone: it keeps nothing here. */
	forget(id: string): void {
		this.waiting.delete(id)
		this.started.delete(id)
		for (const kind of Object.keys(NOTICE_SENTENCES) as NoticeKind[])
			this.shown.delete(`${kind}:${id}`)
	}

	/** A window gained focus: whatever was waiting to be shown or was shown is moot. */
	focused(): void {
		this.cancelFold?.()
		this.cancelFold = undefined
		this.batch.clear()
		this.shown.clear()
		const open = this.open.splice(0)
		for (const notice of open) notice.close()
	}

	private enabled(kind: NoticeKind): boolean {
		const settings = this.host.settings()
		return kind === 'needs-you'
			? settings.needsYou
			: kind === 'failed'
				? settings.failed
				: settings.finished
	}

	private raise(kind: NoticeKind, id: string): void {
		if (!this.host.supported() || !this.enabled(kind) || this.host.windowFocused()) return
		const key = `${kind}:${id}`
		if (this.shown.has(key)) return
		const ids = this.batch.get(kind) ?? []
		if (ids.includes(id)) return
		ids.push(id)
		this.batch.set(kind, ids)
		if (!this.cancelFold)
			this.cancelFold = this.host.schedule(this.host.foldMs?.() ?? FOLD_MS, () => this.flush())
	}

	private flush(): void {
		this.cancelFold = undefined
		const batch = [...this.batch.entries()]
		this.batch.clear()
		// The person may have come back while the events were folding.
		if (this.host.windowFocused()) return
		const silent = !this.host.settings().sound
		for (const [kind, ids] of batch) {
			for (const id of ids) this.shown.add(`${kind}:${id}`)
			const first = ids[0]
			if (first === undefined) continue
			const single = ids.length === 1
			const payload: NoticePayload = {
				title: single ? (this.host.projectName(first) ?? FALLBACK_TITLE) : FALLBACK_TITLE,
				body: single ? NOTICE_SENTENCES[kind] : GROUP_SENTENCES[kind](ids.length),
				silent,
			}
			const notice = this.host.show(payload, () => this.host.open(first))
			if (notice) this.open.push(notice)
		}
	}
}
