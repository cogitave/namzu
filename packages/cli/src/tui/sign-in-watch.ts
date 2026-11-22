/**
 * A turn the browser paused for a sign-in goes on by itself once the page
 * stops asking. The watch only looks (`peek` reads the open page, it never
 * clicks, types or touches cookies); it polls on a timer, needs two
 * `cleared` answers in a row before it acts, and gives up after a fixed time
 * so a window left alone does not poll for ever.
 */

export type SignInPeek = 'still-required' | 'cleared' | 'unknown'

/** How often the open page is looked at. */
export const SIGNIN_POLL_MS = 3_000
/** How long one pause is watched before the watch gives up (10 minutes). */
export const SIGNIN_WATCH_MS = 10 * 60_000
/** Consecutive `cleared` looks needed before the turn continues. */
export const SIGNIN_CLEARED_LOOKS = 2
/** Automatic continues per pause chain without the person acting in between. */
export const SIGNIN_AUTO_RESUME_CAP = 2

export interface SignInWatchOptions {
	/** Read the open page; may be slow. */
	readonly peek: () => Promise<SignInPeek>
	/** False while the screen is busy or the person is typing: the look is skipped. */
	readonly ready?: () => boolean
	/** The page stopped asking, twice in a row. Called once. */
	readonly onCleared: () => void
	/** The watch ran out of time. Called once. */
	readonly onTimeout: () => void
	readonly pollMs?: number
	readonly watchMs?: number
}

/** Start watching. Returns the function that stops it. */
export function startSignInWatch(options: SignInWatchOptions): () => void {
	const pollMs = options.pollMs ?? SIGNIN_POLL_MS
	let stopped = false
	let looking = false
	let cleared = 0
	const finish = () => {
		stopped = true
		clearInterval(poll)
		clearTimeout(limit)
	}
	const poll = setInterval(() => {
		if (stopped || looking) return
		if (options.ready && !options.ready()) {
			cleared = 0
			return
		}
		looking = true
		void options
			.peek()
			.catch((): SignInPeek => 'unknown')
			.then((answer) => {
				looking = false
				if (stopped) return
				cleared = answer === 'cleared' ? cleared + 1 : 0
				if (cleared >= SIGNIN_CLEARED_LOOKS) {
					finish()
					options.onCleared()
				}
			})
	}, pollMs)
	const limit = setTimeout(() => {
		if (stopped) return
		finish()
		options.onTimeout()
	}, options.watchMs ?? SIGNIN_WATCH_MS)
	return finish
}
