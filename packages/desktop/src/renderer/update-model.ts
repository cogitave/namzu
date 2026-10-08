import {
	type UpdateState,
	type UpdateUiBusy,
	updateBlockerText,
} from '../shared/update-protocol.js'

/** Typing within this window counts as someone at the keyboard. */
export const typingQuietMs = 3_000

export type UpdateBadge = { visible: false } | { visible: true; label: string; tooltip: string }

/** The small download button above the profile avatar, shown only for an installable update. */
export function updateBadge(state: UpdateState): UpdateBadge {
	if (state.status !== 'ready') return { visible: false }
	return {
		visible: true,
		label: `Update ready. Restart Namzu to install version ${state.version}`,
		tooltip: 'Update ready — restart to install',
	}
}

/** One polite announcement when an update first becomes ready; nothing else is announced. */
export function updateAnnouncement(previous: UpdateState, next: UpdateState): string {
	if (next.status === 'ready' && previous.status !== 'ready')
		return `Update downloaded. Restart Namzu to install version ${next.version}.`
	return ''
}

export type UpdateDialogAction = 'restart' | 'retry' | 'later' | 'close'

export interface UpdateDialogModel {
	title: string
	body: string
	/** Plain-language reasons a restart is waiting. */
	reasons: string[]
	/** `value` null is an indeterminate bar; no install percentage is ever invented. */
	progress?: { value: number | null; text: string }
	actions: UpdateDialogAction[]
	/** Escape and the backdrop close it, except while the installer is taking over. */
	dismissible: boolean
}

const restartBody = 'Namzu will restart when installation finishes.'

export function updateDialogModel(state: UpdateState): UpdateDialogModel | undefined {
	switch (state.status) {
		case 'downloading':
			return {
				title: 'Downloading update',
				body: 'Namzu will offer to restart when the download finishes.',
				reasons: [],
				progress: { value: state.percent, text: `${state.percent}%` },
				actions: ['close'],
				dismissible: true,
			}
		case 'ready':
			if (state.error)
				return {
					title: 'Update not installed',
					body: `${state.error} Namzu is still running.`,
					reasons: [],
					actions: ['retry', 'close'],
					dismissible: true,
				}
			if (state.waiting)
				return {
					title: 'Installing update',
					body: 'Namzu will update when the current reply finishes.',
					reasons: state.waiting.map((reason) => updateBlockerText[reason]),
					progress: { value: null, text: 'Waiting…' },
					actions: ['later'],
					dismissible: true,
				}
			return {
				title: 'Update ready',
				body: `Version ${state.version} is ready. ${restartBody} Your tabs and drafts come back.`,
				reasons: [],
				actions: ['restart', 'later'],
				dismissible: true,
			}
		case 'installing':
			return {
				title: 'Installing update',
				body: restartBody,
				reasons: [],
				progress: {
					value: null,
					text: state.phase === 'preparing' ? 'Preparing…' : 'Installing…',
				},
				actions: [],
				dismissible: false,
			}
		default:
			return undefined
	}
}

/** The quiet profile-menu entry; failures never interrupt. */
export function updateMenuEntry(
	state: UpdateState,
): { label: string; action: 'check' | 'open' } | undefined {
	switch (state.status) {
		case 'idle':
			return { label: 'Check for updates', action: 'check' }
		case 'error':
			return { label: 'Update check failed. Retry', action: 'check' }
		case 'checking':
			return undefined
		case 'downloading':
			return { label: `Downloading update (${state.percent}%)`, action: 'open' }
		case 'ready':
			return { label: 'Restart to update', action: 'open' }
		default:
			return undefined
	}
}

/** What the renderer knows that the main process cannot see. */
export function readUiBusy(facts: {
	foreignDialogs: number
	computerViews: number
	lastInputAt: number | undefined
	now: number
}): UpdateUiBusy {
	return {
		dialogOpen: facts.foreignDialogs > 0,
		typingRecent: facts.lastInputAt !== undefined && facts.now - facts.lastInputAt < typingQuietMs,
		computerSession: facts.computerViews > 0,
	}
}

export function sameUiBusy(a: UpdateUiBusy, b: UpdateUiBusy): boolean {
	return (
		a.dialogOpen === b.dialogOpen &&
		a.typingRecent === b.typingRecent &&
		a.computerSession === b.computerSession
	)
}
