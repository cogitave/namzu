import { useEffect, useRef, useState } from 'react'

/** How often a streaming reply's text may change what is drawn (Goose's useThrottledStreamingText). */
export const streamingTextInterval = 50

export interface Throttle<T> {
	/** Pass the newest value on now if the interval has passed, otherwise keep it for the end of it. */
	push(value: T): void
	/** Pass the newest value on at once and drop any waiting one. */
	flush(value: T): void
	cancel(): void
}

/** Leading and trailing edge: the first value shows at once, a burst shows its last value when the interval ends. */
export function createThrottle<T>(deliver: (value: T) => void, interval: number): Throttle<T> {
	let last = Number.NEGATIVE_INFINITY
	let waiting: { value: T } | undefined
	let timer: ReturnType<typeof setTimeout> | undefined
	const send = (value: T) => {
		last = Date.now()
		deliver(value)
	}
	const cancel = () => {
		if (timer !== undefined) clearTimeout(timer)
		timer = undefined
		waiting = undefined
	}
	return {
		push(value) {
			const remaining = last + interval - Date.now()
			if (remaining <= 0 && timer === undefined) return send(value)
			waiting = { value }
			if (timer !== undefined) return
			timer = setTimeout(
				() => {
					timer = undefined
					const next = waiting
					waiting = undefined
					if (next) send(next.value)
				},
				Math.max(0, remaining),
			)
		},
		flush(value) {
			cancel()
			send(value)
		},
		cancel,
	}
}

/** The text a live reply draws: at most one change per interval. Once it is not live, the text itself. */
export function useThrottledText(text: string, live: boolean, interval = streamingTextInterval) {
	const [shown, setShown] = useState(text)
	const throttle = useRef<Throttle<string> | undefined>(undefined)
	throttle.current ??= createThrottle(setShown, interval)
	useEffect(() => {
		if (live) throttle.current?.push(text)
		else throttle.current?.flush(text)
	}, [text, live])
	useEffect(() => () => throttle.current?.cancel(), [])
	return live ? shown : text
}
