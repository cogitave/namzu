/**
 * Whether motion should be reduced, for the code that times its own animations. The CSS follows
 * the `data-motion` attribute on the root (see theme.css); this answers the same question for
 * script: `reduce` and `full` decide, and `system` asks the device's flag.
 *
 * The object it returns is the part of a `MediaQueryList` the callers use, so a call site only
 * swaps `matchMedia('(prefers-reduced-motion: reduce)')` for `reducedMotion(view)`.
 */
const QUERY = '(prefers-reduced-motion: reduce)'
export const MOTION_EVENT = 'namzu-motion-change'

export interface ReducedMotion {
	readonly matches: boolean
	addEventListener(type: 'change', listener: () => void): void
	removeEventListener(type: 'change', listener: () => void): void
}

interface MotionView {
	matchMedia?: (query: string) => {
		matches: boolean
		addEventListener?: (type: 'change', listener: () => void) => void
		removeEventListener?: (type: 'change', listener: () => void) => void
	}
	document?: { documentElement?: { getAttribute(name: string): string | null } }
	addEventListener?: (type: string, listener: () => void) => void
	removeEventListener?: (type: string, listener: () => void) => void
}

export function reducedMotion(view: MotionView | null | undefined): ReducedMotion | undefined {
	if (!view) return undefined
	const device = view.matchMedia?.(QUERY)
	const choice = () => view.document?.documentElement?.getAttribute('data-motion')
	return {
		get matches() {
			const current = choice()
			if (current === 'reduce') return true
			if (current === 'full') return false
			return device?.matches ?? false
		},
		addEventListener(type, listener) {
			device?.addEventListener?.(type, listener)
			view.addEventListener?.(MOTION_EVENT, listener)
		},
		removeEventListener(type, listener) {
			device?.removeEventListener?.(type, listener)
			view.removeEventListener?.(MOTION_EVENT, listener)
		},
	}
}

/** Tell every listener that the choice changed, so running animations stop or may start. */
export function announceMotionChange(view: { dispatchEvent(event: Event): boolean }): void {
	view.dispatchEvent(new Event(MOTION_EVENT))
}
