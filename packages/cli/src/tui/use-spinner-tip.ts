import { useEffect, useRef, useState } from 'react'

import { SPINNER_TIPS, type Tip, type TipContext, pickTip } from './spinner-tips.js'
import type { TipHistoryStore } from './tip-history.js'

export interface SpinnerTipInput {
	readonly store: TipHistoryStore | undefined
	/** `tui.spinnerTips`, with this session's `/config tips` choice applied. */
	readonly enabled: boolean
	/** True while a reply is in flight (thinking, running a tool or waiting on a permission). */
	readonly busy: boolean
	readonly statusLineSet: boolean
	readonly notificationsSet: boolean
	/** Tool calls the reply that just ended made. */
	readonly lastTurnToolCalls: () => number
	readonly env?: Readonly<Record<string, string | undefined>>
	readonly tips?: readonly Tip[]
}

/**
 * The tip for the next reply's working row. It is picked once, when a reply
 * ends, and recorded then (not when it is shown); it does not change while
 * the next reply runs. A launch's first reply shows none: nothing has ended
 * yet. Turning tips off clears it at once.
 */
export function useSpinnerTip(input: SpinnerTipInput): string | undefined {
	const [tip, setTip] = useState<string | undefined>(undefined)
	const wasBusy = useRef(false)
	const failed = useRef(new Set<string>())
	const latest = useRef(input)
	latest.current = input
	useEffect(() => {
		if (!input.enabled) {
			setTip(undefined)
			return
		}
		const ended = wasBusy.current && !input.busy
		wasBusy.current = input.busy
		if (!ended) return
		const now = latest.current
		const store = now.store
		if (store === undefined) return
		const history = store.read()
		const ctx: TipContext = {
			launch: history.launches,
			used: (command) => history.used[command] ?? 0,
			env: now.env ?? process.env,
			statusLineSet: now.statusLineSet,
			notificationsSet: now.notificationsSet,
			lastTurnToolCalls: now.lastTurnToolCalls(),
		}
		const picked = pickTip(now.tips ?? SPINNER_TIPS, ctx, history, failed.current)
		if (picked) store.recordShown(picked.id)
		setTip(picked?.text)
	}, [input.busy, input.enabled])
	return input.enabled ? tip : undefined
}
