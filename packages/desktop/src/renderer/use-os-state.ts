import { useCallback, useEffect, useState } from 'react'
import type { OsState } from '../shared/os-state.js'
import type { DesktopApi } from '../shared/protocol.js'

/**
 * What the system says about the rows it applies, read when `active` turns on and again whenever any
 * window saves a setting (main's `settings` event), because applying a row can change the answer.
 * `null` where there is no host to ask; `undefined` until it answers.
 */
export function useOsState(
	api: Pick<DesktopApi, 'osState' | 'onEvent'> | undefined,
	active = true,
): OsState | null | undefined {
	const [state, setState] = useState<OsState>()
	const read = useCallback(
		(live: () => boolean) => {
			void api
				?.osState?.()
				.then((value) => live() && setState(value))
				.catch(() => undefined)
		},
		[api],
	)
	useEffect(() => {
		if (!active || !api?.osState) return
		let live = true
		read(() => live)
		const stop = api.onEvent?.((event) => {
			if (event.kind === 'settings') read(() => live)
		})
		// A change made in the system's own settings while Namzu runs shows when the person comes back.
		const again = () => read(() => live)
		window.addEventListener('focus', again)
		return () => {
			live = false
			stop?.()
			window.removeEventListener('focus', again)
		}
	}, [api, active, read])
	return api?.osState ? state : null
}
