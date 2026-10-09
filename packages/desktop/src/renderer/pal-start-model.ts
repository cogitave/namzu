import type { PalInboxStartView } from '../shared/protocol.js'
import { COMPUTER_SETUP_NOTICE, computerMissingSentence } from './pal-computer-notice.js'

/** What this window knows about starting one Pal from its waiting messages. */
export interface PalStartEntry {
	/** The last answer from the Pal's host; absent until the first read. */
	view?: PalInboxStartView
	/** The person clicked Start in this window for the messages now waiting. */
	clicked: boolean
	/** A start request is on its way to the host. */
	pending: boolean
	/** "Not now": the question is hidden here; the Pal's own page still offers Start. */
	dismissed: boolean
	/** The start request itself failed before the host answered. */
	error?: string
	/** A run the person started has finished reading. */
	finished: boolean
	/**
	 * The Pal's computer cannot start on this machine (no container engine or image), read together
	 * with the inbox. `raw` is the host's own wording, only used to pick the plain sentence.
	 */
	setupMissing?: { raw?: string }
	/**
	 * The last failed start is stale: the person dismissed it, or the Pal's computer changed since.
	 * The messages still wait; only the old failure stops being shown.
	 */
	failureHidden?: boolean
}

export const emptyPalStart: PalStartEntry = {
	clicked: false,
	pending: false,
	dismissed: false,
	finished: false,
}

export type PalStartCard =
	| { kind: 'none' }
	| { kind: 'ask'; text: string }
	/** Start is switched off: the Pal's computer cannot start yet. `help` says how to set it up. */
	| { kind: 'blocked'; text: string; help: string }
	| { kind: 'resume'; text: string }
	| { kind: 'starting'; text: string }
	| { kind: 'reading'; text: string; openable: boolean }
	| { kind: 'done'; text: string }
	| { kind: 'failed'; text: string }

const retryText = (name: string) => `${name} could not be started. Try again in a moment.`

/** The card under a "sent to a Pal" row. Plain words only; a host's raw error is never shown. */
export function palStartCard(
	name: string,
	paused: boolean,
	entry: PalStartEntry | undefined,
): PalStartCard {
	if (!entry) return { kind: 'none' }
	if (entry.pending) return { kind: 'starting', text: `Starting ${name}…` }
	if (entry.error) return { kind: 'failed', text: retryText(name) }
	const view = entry.view
	if (!view) return { kind: 'none' }
	if (view.state === 'failed' && !entry.failureHidden)
		return { kind: 'failed', text: view.message?.trim() || retryText(name) }
	if (view.state === 'reading')
		return entry.clicked
			? { kind: 'reading', text: `${name} is reading your message.`, openable: true }
			: { kind: 'reading', text: `${name} will read it at its next step.`, openable: false }
	if (view.state === 'empty')
		return entry.finished ? { kind: 'done', text: `${name} read your message.` } : { kind: 'none' }
	if (view.state === 'failed' && view.waiting === 0) return { kind: 'none' }
	if (paused)
		return {
			kind: 'resume',
			text: `${name} is paused. Resume ${name} to let it read your message.`,
		}
	if (entry.dismissed) return { kind: 'none' }
	if (entry.setupMissing)
		return {
			kind: 'blocked',
			text: computerMissingSentence(name, entry.setupMissing.raw),
			help: COMPUTER_SETUP_NOTICE,
		}
	return {
		kind: 'ask',
		text: `${name} is not running. Start ${name} to let it read your message on its own computer.`,
	}
}

/** The line on the Pal's own page while messages wait for the person's go. */
export function palWaitingLine(
	name: string,
	paused: boolean,
	entry: PalStartEntry | undefined,
): {
	text: string
	action: 'start' | 'resume' | 'retry' | null
	/** Start is switched off, with how to set the computer up. */
	blocked?: { text: string; help: string }
} | null {
	const view = entry?.view
	if (!entry || !view) return null
	if (entry.pending) return { text: `Starting ${name}…`, action: null }
	if (view.state === 'reading') return { text: `${name} is reading your messages.`, action: null }
	if ((view.state === 'failed' && !entry.failureHidden) || entry.error)
		return { text: view.message?.trim() || retryText(name), action: 'retry' }
	if (view.state !== 'waiting' && view.state !== 'failed') return null
	if (view.waiting === 0) return null
	const count = view.waiting === 1 ? '1 unread message' : `${view.waiting} unread messages`
	if (paused) return { text: `${count} · ${name} is paused`, action: 'resume' }
	if (entry.setupMissing)
		return {
			text: count,
			action: 'start',
			blocked: {
				text: computerMissingSentence(name, entry.setupMissing.raw),
				help: COMPUTER_SETUP_NOTICE,
			},
		}
	return { text: count, action: 'start' }
}

/** Fold one answer from the host into what the window knows. */
export function afterRead(
	entry: PalStartEntry | undefined,
	view: PalInboxStartView,
): PalStartEntry {
	const base = entry ?? emptyPalStart
	const wasReading = base.view?.state === 'reading'
	// A failure that is read again unchanged stays as hidden as it was; a new one shows.
	const sameFailure =
		view.state === 'failed' && base.view?.state === 'failed' && base.view.message === view.message
	const failureHidden = sameFailure ? base.failureHidden : false
	if (view.state === 'empty')
		return {
			...base,
			view,
			error: undefined,
			failureHidden,
			finished: base.finished || (base.clicked && wasReading),
		}
	if (view.state === 'waiting' && base.view?.state === 'empty')
		// New messages after everything was read are a new question.
		return { ...emptyPalStart, view, failureHidden }
	return { ...base, view, error: undefined, failureHidden }
}

/**
 * What the sidebar dot beside a Pal says. It marks a message the person sent and has not opened;
 * the state says whether that message is waiting, being read, or could not be delivered to a
 * running Pal, so the dot never reads as "all is well" after a failed start.
 */
export function palMarker(
	name: string,
	entry: PalStartEntry | undefined,
): { state: 'waiting' | 'reading' | 'failed'; label: string } {
	const view = entry?.view
	if (entry?.pending || view?.state === 'reading')
		return { state: 'reading', label: `${name} is reading your message` }
	if (entry?.error || (view?.state === 'failed' && !entry?.failureHidden))
		return {
			state: 'failed',
			label: `${name} could not be started. Your message is still waiting.`,
		}
	return { state: 'waiting', label: `Your message is waiting for ${name}` }
}
