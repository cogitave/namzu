import { useCallback, useEffect, useRef, useState } from 'react'
import type { PalComputerSetupState } from '../shared/pal-computer-setup.js'
import type { DesktopApi } from '../shared/protocol.js'

type SetupApi = Pick<
	DesktopApi,
	'palComputerSetup' | 'runPalComputerSetup' | 'restartPc' | 'onPalComputerSetup'
>

/**
 * What this PC needs before a Pal's computer can run. Main owns the answer and the run; this keeps
 * the latest of both in view. Where the app has no host for it, `state` stays undefined and the
 * Pal computer row behaves as it always did.
 */
export function usePalComputerSetup(api: SetupApi) {
	const [state, setState] = useState<PalComputerSetupState | undefined>()
	const latest = useRef(api)
	latest.current = api
	const available = Boolean(api.palComputerSetup)
	useEffect(() => {
		if (!available) return
		let live = true
		const off = latest.current.onPalComputerSetup?.((next) => {
			if (live) setState(next)
		})
		void latest.current
			.palComputerSetup?.()
			.then((next) => {
				// A newer event may already have arrived; the event is the later word.
				if (live) setState((current) => current ?? next)
			})
			.catch(() => {})
		return () => {
			live = false
			off?.()
		}
	}, [available])
	const refresh = useCallback(async () => {
		try {
			const next = await latest.current.palComputerSetup?.(true)
			if (next) setState(next)
		} catch {
			// The row keeps what it knew.
		}
	}, [])
	const run = useCallback(
		async (planId: string, palId: string) => {
			try {
				const next = await latest.current.runPalComputerSetup?.(planId, palId)
				if (next) setState(next)
			} catch {
				// Main refused or the plan changed; the state it published says what is true now.
				await refresh()
			}
		},
		[refresh],
	)
	const restart = useCallback(async () => {
		try {
			await latest.current.restartPc?.()
		} catch {
			await refresh()
		}
	}, [refresh])
	return { state, refresh, run, restart }
}
