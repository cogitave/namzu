import { useEffect, useState } from 'react'
import type { DesktopApi, ProjectPrView } from '../shared/protocol.js'
import { POLL_FAILURE_LIMIT } from './failing-poll.js'

/** How long a pull request answer stays before the next look while nothing is running. */
export const PULL_REQUEST_POLL_MS = 90_000

interface Listening {
	addEventListener(type: string, listener: () => void): void
	removeEventListener(type: string, listener: () => void): void
}

/**
 * Looks now and then every `PULL_REQUEST_POLL_MS`; the slow poll leaves a failing look alone after
 * `POLL_FAILURE_LIMIT` in a row, and the window coming back (focus, or visible again) forgets the
 * failures and looks at once. Returns the function that ends it.
 */
export function startPullRequestLook(options: {
	look: () => Promise<ProjectPrView | null>
	onFound: (pr: ProjectPrView | null) => void
	document: Listening & { visibilityState: string }
	window: Listening
}): () => void {
	let current = true
	let failures = 0
	const read = () => {
		if (options.document.visibilityState === 'hidden') return
		void options.look().then(
			(pr) => {
				failures = 0
				if (current) options.onFound(pr)
			},
			() => {
				failures += 1
				if (current) options.onFound(null)
			},
		)
	}
	const back = () => {
		failures = 0
		read()
	}
	read()
	const timer = setInterval(() => {
		if (failures < POLL_FAILURE_LIMIT) read()
	}, PULL_REQUEST_POLL_MS)
	options.document.addEventListener('visibilitychange', back)
	options.window.addEventListener('focus', back)
	return () => {
		current = false
		clearInterval(timer)
		options.document.removeEventListener('visibilitychange', back)
		options.window.removeEventListener('focus', back)
	}
}

/**
 * The pull request of a project's branch, for the composer footer. It asks when the project opens, when a
 * reply ends (an agent may have switched branches or pushed), and then on a slow interval while the window
 * is visible. Never while a reply runs. Any failure is the same as no pull request: nothing is shown.
 */
export function usePullRequest(
	api: Pick<DesktopApi, 'projectPr'> | undefined,
	projectId: string | undefined,
	options: { enabled: boolean; running: boolean },
): ProjectPrView | null {
	const [found, setFound] = useState<{ projectId: string; pr: ProjectPrView | null }>()
	const lookup = api?.projectPr
	const { enabled, running } = options
	useEffect(() => {
		if (!enabled || !lookup || !projectId || running) return
		return startPullRequestLook({
			look: () => Promise.resolve(lookup(projectId)),
			onFound: (pr) => setFound({ projectId, pr }),
			document,
			window,
		})
	}, [enabled, lookup, projectId, running])
	return enabled && found && found.projectId === projectId ? found.pr : null
}
