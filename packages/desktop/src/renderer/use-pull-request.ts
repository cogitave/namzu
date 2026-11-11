import { useEffect, useState } from 'react'
import type { DesktopApi, ProjectPrView } from '../shared/protocol.js'
import { POLL_FAILURE_LIMIT } from './failing-poll.js'

/** How long a pull request answer stays before the next look while nothing is running. */
export const PULL_REQUEST_POLL_MS = 90_000

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
		let current = true
		// Looks in a row that failed: the slow poll leaves a failing look alone after a few; coming
		// back to the window asks again.
		let failures = 0
		const read = () => {
			if (document.visibilityState === 'hidden') return
			void Promise.resolve(lookup(projectId)).then(
				(pr) => {
					failures = 0
					if (current) setFound({ projectId, pr })
				},
				() => {
					failures += 1
					if (current) setFound({ projectId, pr: null })
				},
			)
		}
		read()
		const timer = setInterval(() => {
			if (failures < POLL_FAILURE_LIMIT) read()
		}, PULL_REQUEST_POLL_MS)
		document.addEventListener('visibilitychange', read)
		return () => {
			current = false
			clearInterval(timer)
			document.removeEventListener('visibilitychange', read)
		}
	}, [enabled, lookup, projectId, running])
	return enabled && found && found.projectId === projectId ? found.pr : null
}
