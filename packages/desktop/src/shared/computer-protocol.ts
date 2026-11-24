/**
 * What the Namzu host says about its `computer_use` tool, read before anything trusts it. The desktop
 * half of `packages/cli/src/commands/desktop-computer-feed.ts`: the notification is
 * `namzu/session/computer-frame`, one per call that returned a screenshot to the model.
 *
 * The picture is small already (the host fits it); this side still bounds it, because the host can be
 * another version, and keeps only the newest few per conversation.
 */
export const COMPUTER_FRAME_NOTIFICATION = 'namzu/session/computer-frame'

/** Pictures kept per conversation; the oldest are let go first. */
export const MAX_COMPUTER_FRAMES = 8
/** The most base64 characters of one picture taken at face value (about 600 KB of PNG). */
export const MAX_COMPUTER_FRAME_CHARS = 800_000
const MAX_ID = 200
const MAX_TEXT = 300
const MAX_EDGE = 4096

/** What a person is shown of one call: the picture the model received, and where a click landed. */
export interface ComputerFrameView {
	sessionId: string
	/** The call row this belongs to. */
	toolCallId?: string
	frameId: string
	/** What the model did, in the words of the call row. */
	action: string
	/** The application the call worked on, when the host could tell. */
	app?: string
	mimeType: 'image/png'
	/** The picture, base64. */
	data: string
	width: number
	height: number
	/** Where a click landed, as fractions of the picture. */
	point?: { x: number; y: number }
}

/** The applications a conversation has allowed and the ones it has used. */
export interface ComputerAppsView {
	/** Allowed for this conversation; the person can take each back. */
	granted: string[]
	/** Used in this conversation, allowed or not (Full access lists them without a card). */
	used: string[]
}

/** Browsers whose process name is not how a person says it: the name they know, by lower case process name. */
const BROWSER_NAMES: Record<string, string> = {
	'brave-browser': 'Brave',
	'brave browser': 'Brave',
	brave: 'Brave',
	'google-chrome': 'Chrome',
	'google chrome': 'Chrome',
	chrome: 'Chrome',
	msedge: 'Microsoft Edge',
	'microsoft-edge': 'Microsoft Edge',
	'microsoft edge': 'Microsoft Edge',
	firefox: 'Firefox',
}

/** The name an application is compared by: no case, no `.exe`, and one name for a browser. */
export function appKey(name: string): string {
	const bare = name
		.trim()
		.replace(/\.exe$/i, '')
		.toLowerCase()
	// A browser is one application whatever the host calls it: the process, or the name a person knows.
	const known = BROWSER_NAMES[bare]
	return known ? known.toLowerCase() : bare
}

/** An application as a person reads it: no `.exe`, a browser by its own name, and a lowercase process name starts with a capital. */
export function appLabel(name: string): string {
	if (name === WHOLE_SCREEN) return name
	const bare = name.trim().replace(/\.exe$/i, '')
	const known = BROWSER_NAMES[bare.toLowerCase()]
	if (known) return known
	return bare && bare === bare.toLowerCase()
		? `${bare.charAt(0).toUpperCase()}${bare.slice(1)}`
		: bare
}

/** What the grants and pictures stand for when the host cannot name an application (a bare screen). */
export const WHOLE_SCREEN = 'the screen'

function plain(value: unknown, max: number): string | undefined {
	if (typeof value !== 'string') return undefined
	const text = value
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	return text && text.length <= max ? text : undefined
}

const edge = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_EDGE
		? value
		: undefined

const fraction = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined

/** The picture a host announced, or `undefined` when it does not read or is too big. */
export function readComputerFrame(value: unknown): ComputerFrameView | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
	const raw = value as Record<string, unknown>
	const sessionId = plain(raw.sessionId, MAX_ID)
	const frameId = plain(raw.frameId, MAX_ID)
	const action = plain(raw.action, MAX_TEXT)
	const width = edge(raw.width)
	const height = edge(raw.height)
	if (!sessionId || !frameId || !action || !width || !height) return undefined
	if (raw.mimeType !== 'image/png') return undefined
	if (
		typeof raw.data !== 'string' ||
		raw.data.length === 0 ||
		raw.data.length > MAX_COMPUTER_FRAME_CHARS ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(raw.data)
	)
		return undefined
	const toolCallId = plain(raw.toolUseId, MAX_ID)
	const app = plain(raw.app, 120)
	const point =
		typeof raw.point === 'object' && raw.point !== null
			? (() => {
					const p = raw.point as Record<string, unknown>
					const x = fraction(p.x)
					const y = fraction(p.y)
					return x !== undefined && y !== undefined ? { x, y } : undefined
				})()
			: undefined
	return {
		sessionId,
		...(toolCallId ? { toolCallId } : {}),
		frameId,
		action,
		...(app ? { app } : {}),
		mimeType: 'image/png',
		data: raw.data,
		width,
		height,
		...(point ? { point } : {}),
	}
}

/** The pictures after one more, the oldest dropped once there are more than {@link MAX_COMPUTER_FRAMES}. */
export function keepFrames(
	frames: readonly ComputerFrameView[],
	next: ComputerFrameView,
): ComputerFrameView[] {
	const kept = [
		...frames.filter((frame) => frame.toolCallId !== next.toolCallId || !next.toolCallId),
		next,
	]
	return kept.slice(-MAX_COMPUTER_FRAMES)
}
