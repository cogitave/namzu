import { useEffect, useState } from 'react'
import { nextLocalMidnight } from './sidebar-date-groups.js'

/**
 * Draws again when the local day changes, so "Today" becomes "Yesterday" while the window is
 * open. The wait is computed from the calendar, not 24 hours, and starts over after each change.
 */
export function useLocalDay(now: () => number = Date.now): void {
	const [day, setDay] = useState(() => nextLocalMidnight(now()))
	useEffect(() => {
		const wait = Math.max(1000, day - now() + 1000)
		const timer = setTimeout(() => setDay(nextLocalMidnight(now())), wait)
		return () => clearTimeout(timer)
	}, [day, now])
}
