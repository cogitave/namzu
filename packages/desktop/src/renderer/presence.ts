import { type AnimationEvent, useEffect, useState } from 'react'

const reducedMotion = () =>
	typeof window !== 'undefined' &&
	typeof window.matchMedia === 'function' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Longer than any exit animation here; the safety net for an `animationend` that never arrives. */
const EXIT_LIMIT_MS = 600

/**
 * Keeps an element mounted while its exit animation runs. `present` is true while it should be in
 * the tree; `done` goes on the element's `onAnimationEnd` and unmounts it once the exit finishes.
 * Under reduced motion there is no exit animation, so it unmounts at once. A change of `scope`
 * (another conversation) drops the element without an exit, since nothing was sent in that view.
 */
export function usePresence(
	wanted: boolean,
	scope?: string,
): [present: boolean, done: (event: AnimationEvent) => void] {
	const [present, setPresent] = useState(wanted)
	const [seen, setSeen] = useState(scope)
	if (seen !== scope) {
		setSeen(scope)
		setPresent(wanted)
	} else if (wanted && !present) setPresent(true)
	useEffect(() => {
		if (wanted || !present) return
		if (reducedMotion()) {
			setPresent(false)
			return
		}
		// A hidden window or a lost stylesheet can swallow the animation; never leave the tray stuck.
		const timer = setTimeout(() => setPresent(false), EXIT_LIMIT_MS)
		return () => clearTimeout(timer)
	}, [wanted, present])
	return [
		present,
		(event) => {
			if (!wanted && event.target === event.currentTarget) setPresent(false)
		},
	]
}
