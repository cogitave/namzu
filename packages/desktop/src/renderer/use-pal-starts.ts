import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThreadState } from '../shared/projection.js'
import type { DesktopApi } from '../shared/protocol.js'
import { computerSetupMissing } from './pal-computer-notice.js'
import { type PalStartEntry, afterRead, emptyPalStart } from './pal-start-model.js'
import { newPalSendTargets } from './pal-unread.js'

type StartApi = Pick<DesktopApi, 'palInboxStart' | 'startPalInbox'> &
	Partial<Pick<DesktopApi, 'palComputer'>>

/** How often a run the person started is checked until it has read the messages. */
const READING_POLL_MS = 2000

/**
 * The start question for Pals the person has messaged. It reads the Pal's inbox once when a
 * message to it is sent (and when its page opens) and offers Start; it starts nothing on its own.
 */
export function usePalStarts(
	api: StartApi,
	threads: Readonly<Record<string, ThreadState>>,
	pals: readonly { id: string; name: string }[],
	openPalId: string | undefined,
) {
	const [entries, setEntries] = useState<Readonly<Record<string, PalStartEntry>>>({})
	const seen = useRef(new Set<string>())
	const mounted = useRef(true)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])
	const update = useCallback((palId: string, change: (entry: PalStartEntry) => PalStartEntry) => {
		if (!mounted.current) return
		setEntries((all) => ({ ...all, [palId]: change(all[palId] ?? emptyPalStart) }))
	}, [])
	const refresh = useCallback(
		async (palId: string) => {
			if (!api.palInboxStart) return
			try {
				const [view, computer] = await Promise.all([
					api.palInboxStart(palId),
					// Whether Start can work at all: asked with the inbox so the offer never promises a start
					// that will fail. An unreadable computer simply leaves the offer as it was.
					Promise.resolve(api.palComputer?.(palId)).catch(() => undefined),
				])
				const missing =
					computer?.status === 'unavailable' && computerSetupMissing(computer.notice)
						? { raw: computer.notice }
						: undefined
				update(palId, (entry) => ({ ...afterRead(entry, view), setupMissing: missing }))
			} catch {
				// An older runtime or a Pal that cannot be read simply shows no question.
			}
		},
		[api, update],
	)
	useEffect(() => {
		for (const palId of newPalSendTargets(seen.current, threads, pals)) void refresh(palId)
	}, [threads, pals, refresh])
	useEffect(() => {
		if (openPalId) void refresh(openPalId)
	}, [openPalId, refresh])
	const reading = Object.entries(entries)
		.filter(([, entry]) => entry.view?.state === 'reading')
		.map(([palId]) => palId)
		.join('\n')
	useEffect(() => {
		if (!reading) return
		const ids = reading.split('\n')
		const timer = setInterval(() => {
			for (const palId of ids) void refresh(palId)
		}, READING_POLL_MS)
		return () => clearInterval(timer)
	}, [reading, refresh])
	const start = useCallback(
		async (palId: string) => {
			if (!api.startPalInbox) return
			update(palId, (entry) => ({
				...entry,
				clicked: true,
				pending: true,
				error: undefined,
				failureHidden: false,
			}))
			try {
				const view = await api.startPalInbox(palId)
				update(palId, (entry) => ({ ...afterRead(entry, view), pending: false }))
			} catch {
				update(palId, (entry) => ({ ...entry, pending: false, error: 'start-failed' }))
			}
		},
		[api, update],
	)
	const dismiss = useCallback(
		(palId: string) => update(palId, (entry) => ({ ...entry, dismissed: true })),
		[update],
	)
	const clearFailure = useCallback(
		(palId: string) =>
			update(palId, (entry) => ({ ...entry, error: undefined, failureHidden: true })),
		[update],
	)
	return { entries, start, dismiss, refresh, clearFailure, enabled: Boolean(api.startPalInbox) }
}
