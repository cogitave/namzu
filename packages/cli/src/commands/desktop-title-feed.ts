import type { SessionEvent, SessionId, TurnId } from '@namzu/sdk'
import { generateTitle } from '../integrations/sessions/ai-title.js'
import type { SideModel } from '../integrations/small-model/side-model.js'

/**
 * The name the small model gives a conversation, told to the desktop so its
 * sidebar and header can show it in place of the first words typed.
 *
 * The terminal asks for the same name after a conversation's first message
 * (`ai-title.ts`); this is the desktop host doing that once per conversation,
 * beside the first turn, and saying the result as one `namzu/` notification.
 * A failed request says nothing: the desktop keeps what it already shows.
 */
export const TITLE_NOTIFICATION = 'namzu/session/title'

/** Longest title the desktop is sent, in characters. */
export const TITLE_NOTIFICATION_MAX = 60

export interface TitleNotification {
	readonly sessionId: string
	/** One line, at most {@link TITLE_NOTIFICATION_MAX} characters, in the language of the message. */
	readonly title: string
}

/** A title cut to the length the desktop takes, on a word edge when one is near. */
export function fitTitle(title: string): string {
	if (title.length <= TITLE_NOTIFICATION_MAX) return title
	const cut = title.slice(0, TITLE_NOTIFICATION_MAX - 1)
	const space = cut.lastIndexOf(' ')
	const kept = space >= TITLE_NOTIFICATION_MAX / 2 ? cut.slice(0, space) : cut
	return `${kept.trimEnd()}…`
}

export interface TitleFeedOptions {
	readonly notify: (method: string, params: Record<string, unknown>) => void
	/** The small model of the conversation, or `undefined` when it has none. */
	readonly sideModel: (sessionId: string) => SideModel | undefined
	/** Whether the conversation already has a name worth keeping. */
	readonly hasTitle: (sessionId: string) => Promise<boolean>
	/** Saves the title in the conversation's record; rejects while a turn holds the log. */
	readonly save: (sessionId: string, title: string) => Promise<unknown>
	/** Longest a request may take. */
	readonly timeoutMs?: number
}

export interface TitleFeed {
	/** The first message of a conversation: the next `turn_started` of that conversation asks for its name. */
	expect(sessionId: string, message: string): void
	/** Every event of the conversation; starts the request at its turn's start. */
	observe(sessionId: string, event: SessionEvent): void
	/** Tries to save names that were told but not yet kept; call when a turn ends. */
	flush(sessionId: string): Promise<void>
}

export function createTitleFeed(options: TitleFeedOptions): TitleFeed {
	const waiting = new Map<string, string>()
	const attempted = new Set<string>()
	const unsaved = new Map<string, string>()
	const flush = async (sessionId: string): Promise<void> => {
		const title = unsaved.get(sessionId)
		if (title === undefined) return
		try {
			await options.save(sessionId, title)
			if (unsaved.get(sessionId) === title) unsaved.delete(sessionId)
		} catch {
			/* A turn holds the log; the next turn's end tries again. */
		}
	}
	return {
		expect(sessionId, message) {
			if (attempted.has(sessionId)) return
			waiting.set(sessionId, message)
		},
		observe(sessionId, event) {
			if (event.type !== 'turn_started') return
			const message = waiting.get(sessionId)
			if (message === undefined) return
			waiting.delete(sessionId)
			const side = options.sideModel(sessionId)
			if (!side || attempted.has(sessionId)) return
			attempted.add(sessionId)
			void (async () => {
				try {
					if (await options.hasTitle(sessionId)) return
					const generated = await generateTitle({
						sideModel: side,
						sessionId: sessionId as SessionId,
						turnId: event.turnId as TurnId,
						message,
						signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
					})
					if (generated === undefined) {
						attempted.delete(sessionId)
						return
					}
					const title = fitTitle(generated)
					unsaved.set(sessionId, title)
					const body: TitleNotification = { sessionId, title }
					options.notify(TITLE_NOTIFICATION, { ...body })
					await flush(sessionId)
				} catch {
					attempted.delete(sessionId)
				}
			})()
		},
		flush,
	}
}
