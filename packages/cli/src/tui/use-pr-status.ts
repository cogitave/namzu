import { useEffect, useRef, useState } from 'react'

import { PR_NONE, type PrFooterState, PrPoller, type RunCommand } from './pr-status.js'

/**
 * The footer's pull request item. Starts a background poller for the folder,
 * pauses it while a turn runs, and gives it a nudge on each state change so
 * the ladder sees that the person is around.
 *
 * `NAMZU_PR_STATUS=off` turns the item off, as does a missing `enabled`.
 */
export function usePrStatus(input: {
	readonly cwd: string
	readonly enabled: boolean
	readonly turnActive: boolean
	readonly run?: RunCommand
}): PrFooterState {
	const [state, setState] = useState<PrFooterState>(PR_NONE)
	const pollerRef = useRef<PrPoller | null>(null)
	const turnActiveRef = useRef(input.turnActive)
	turnActiveRef.current = input.turnActive
	const { cwd, enabled, run } = input

	useEffect(() => {
		if (!enabled || process.env.NAMZU_PR_STATUS === 'off') {
			setState(PR_NONE)
			return
		}
		const poller = new PrPoller({ cwd, run, onChange: setState })
		pollerRef.current = poller
		poller.setPaused(turnActiveRef.current)
		poller.start()
		return () => {
			poller.stop()
			pollerRef.current = null
		}
	}, [cwd, enabled, run])

	useEffect(() => {
		const poller = pollerRef.current
		if (!poller) return
		poller.touch()
		poller.setPaused(input.turnActive)
	}, [input.turnActive])

	return state
}
