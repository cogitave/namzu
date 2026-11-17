import { useEffect, useState } from 'react'

/**
 * The current time in milliseconds, advanced once a second while `active`. Nothing ticks while it is
 * false, so a closed panel costs no timer.
 */
export function useClock(active: boolean, read: () => number = Date.now): number {
	const [now, setNow] = useState(read)
	useEffect(() => {
		if (!active) return
		setNow(read())
		const timer = setInterval(() => setNow(read()), 1000)
		return () => clearInterval(timer)
	}, [active, read])
	return now
}
