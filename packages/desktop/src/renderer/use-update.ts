import { useEffect, useRef, useState } from 'react'
import type { DesktopApi } from '../shared/protocol.js'
import type { UpdateState, UpdateUiBusy } from '../shared/update-protocol.js'
import { readUiBusy, sameUiBusy, typingQuietMs } from './update-model.js'

/** The shared update state, read once and then pushed by the main process. */
export function useUpdateState(api: DesktopApi | undefined): UpdateState {
	const [state, setState] = useState<UpdateState>({ status: 'disabled' })
	useEffect(() => {
		if (!api?.updateState || !api.onUpdateState) return
		let current = true
		const stop = api.onUpdateState((next) => {
			if (current) setState(next)
		})
		void api
			.updateState()
			.then((initial) => {
				if (current) setState((now) => (now.status === 'disabled' ? initial : now))
			})
			.catch(() => {})
		return () => {
			current = false
			stop()
		}
	}, [api])
	return state
}

const updateDialogSelector = '[data-update-dialog]'
const foreignDialogSelector = `[role="dialog"]:not(${updateDialogSelector}), [role="alertdialog"]`

/**
 * Tells the main process what only this window can see: a foreign dialog, recent typing and
 * an open Pal computer. It reports changes, coalesced, and a quiet period after typing.
 */
export function useUpdateBusyReporter(api: DesktopApi | undefined, active: boolean): void {
	const last = useRef<UpdateUiBusy | undefined>(undefined)
	useEffect(() => {
		if (!api?.reportUiBusy || !active) return
		let lastInputAt: number | undefined
		let pending: ReturnType<typeof setTimeout> | undefined
		let quiet: ReturnType<typeof setTimeout> | undefined
		const report = () => {
			pending = undefined
			const busy = readUiBusy({
				foreignDialogs: document.querySelectorAll(foreignDialogSelector).length,
				computerViews: document.querySelectorAll('.pal-computer-view').length,
				lastInputAt,
				now: Date.now(),
			})
			if (last.current && sameUiBusy(last.current, busy)) return
			last.current = busy
			void api.reportUiBusy?.(busy).catch(() => {})
		}
		const schedule = () => {
			if (pending === undefined) pending = setTimeout(report, 250)
		}
		const onInput = () => {
			lastInputAt = Date.now()
			schedule()
			clearTimeout(quiet)
			quiet = setTimeout(report, typingQuietMs + 100)
		}
		const observer = new MutationObserver(schedule)
		observer.observe(document.body, { childList: true, subtree: true })
		document.addEventListener('input', onInput, true)
		report()
		return () => {
			observer.disconnect()
			document.removeEventListener('input', onInput, true)
			clearTimeout(pending)
			clearTimeout(quiet)
		}
	}, [api, active])
}
