/**
 * The name the Namzu host gives a conversation, read before anything trusts it. The desktop
 * half of `packages/cli/src/commands/desktop-title-feed.ts`: the notification is
 * `namzu/session/title`, once per conversation, after its first message.
 */
export const TITLE_NOTIFICATION = 'namzu/session/title'

/** The most characters of a title taken at face value. */
export const TITLE_MAX = 60

export interface TitleNotice {
	sessionId: string
	title: string
}

const MAX_ID = 200

/** A title that reads: one line of printable text, at most {@link TITLE_MAX} characters. */
export function readTitleNotice(value: unknown): TitleNotice | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
	const raw = value as Record<string, unknown>
	if (
		typeof raw.sessionId !== 'string' ||
		raw.sessionId.length === 0 ||
		raw.sessionId.length > MAX_ID
	)
		return undefined
	if (typeof raw.title !== 'string') return undefined
	const title = raw.title
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	if (title.length === 0 || title.length > TITLE_MAX) return undefined
	return { sessionId: raw.sessionId, title }
}
