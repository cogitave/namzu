/** What keeps the app from restarting right now, in terms a person can act on. */
export type UpdateBlocker =
	| 'turn-running'
	| 'permission-pending'
	| 'background-work'
	| 'dialog-open'
	| 'typing-unsaved'
	| 'computer-session'

/**
 * One state for every window. `ready` keeps the downloaded version; `waiting` is set only after
 * the person chose Restart while something blocked it, and it is cleared by Later.
 */
export type UpdateState =
	| { status: 'disabled' }
	| { status: 'idle' }
	| { status: 'checking' }
	/** Found, not downloaded: automatic download is off and the person has not asked yet. */
	| { status: 'available'; version: string }
	| { status: 'downloading'; percent: number; bytesPerSecond: number }
	| { status: 'ready'; version: string; waiting?: UpdateBlocker[]; error?: string }
	| { status: 'installing'; version: string; phase: 'preparing' | 'installing' }
	| { status: 'error'; message: string }

export type UpdateInstallResult =
	| { ok: true }
	| { ok: false; blockers: UpdateBlocker[] }
	| { ok: false; error: string }

/** The renderer's own facts, which the main process cannot see. */
export interface UpdateUiBusy {
	/** A dialog other than the update dialog is open. */
	dialogOpen: boolean
	/** Text was typed within the last few seconds. */
	typingRecent: boolean
	/** A Pal computer view is on screen. */
	computerSession: boolean
}

export const quietUiBusy: UpdateUiBusy = {
	dialogOpen: false,
	typingRecent: false,
	computerSession: false,
}

export function isUpdateUiBusy(value: unknown): value is UpdateUiBusy {
	if (!value || typeof value !== 'object') return false
	const item = value as Record<string, unknown>
	return (
		typeof item.dialogOpen === 'boolean' &&
		typeof item.typingRecent === 'boolean' &&
		typeof item.computerSession === 'boolean'
	)
}

export const updateBlockerText: Record<UpdateBlocker, string> = {
	'turn-running': 'A reply is still running',
	'permission-pending': 'A permission request is waiting for an answer',
	'background-work': 'Background work is still running',
	'dialog-open': 'A dialog is open',
	'typing-unsaved': 'You are typing',
	'computer-session': 'A Pal computer session is open',
}

/** Facts the Settings page shows beside the state. */
export interface UpdateInfo {
	currentVersion: string
	/** When a check last finished, in milliseconds since the epoch. */
	lastCheckedAt?: number
}
