/**
 * Runs `notifications.ts`: holds the state, owns the one timer, and hands the
 * footer the notice that is up. `add` and `remove` are stable and synchronous
 * (they read the latest state from a ref), so a key handler can call them and
 * the next key sees the result.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
	EMPTY_NOTICES,
	type Notice,
	type NoticeAction,
	type NoticeState,
	reduce,
} from './notifications.js'

export interface NoticeSlot {
	readonly current: Notice | null
	readonly add: (notice: Notice) => void
	readonly remove: (key: string) => void
}

export function useNotifications(): NoticeSlot {
	const stateRef = useRef<NoticeState>(EMPTY_NOTICES)
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const [current, setCurrent] = useState<Notice | null>(null)

	const dispatch = useCallback((action: NoticeAction): void => {
		const step = reduce(stateRef.current, action)
		stateRef.current = step.state
		if (step.timer) {
			if (timerRef.current !== null) clearTimeout(timerRef.current)
			timerRef.current = null
			if (step.timer.kind === 'start') {
				const { key } = step.timer
				const timer = setTimeout(() => {
					timerRef.current = null
					dispatch({ type: 'expire', key })
				}, step.timer.ms)
				timer.unref?.()
				timerRef.current = timer
			}
		}
		setCurrent(step.state.current)
	}, [])

	useEffect(
		() => () => {
			if (timerRef.current !== null) clearTimeout(timerRef.current)
		},
		[],
	)

	const add = useCallback((notice: Notice) => dispatch({ type: 'add', notice }), [dispatch])
	const remove = useCallback((key: string) => dispatch({ type: 'remove', key }), [dispatch])
	return { current, add, remove }
}
