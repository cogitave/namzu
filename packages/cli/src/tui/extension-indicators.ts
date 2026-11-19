import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { useEffect, useState } from 'react'
import { onExtensionState, sharedExtensionHost } from '../commands/desktop-extensions.js'
import type { IndicatorView } from '../integrations/extensions/indicator.js'
import { namzuHomePath } from '../integrations/state/home.js'

/**
 * The always-visible mark of every extension that is running, for the terminal. It runs what is
 * enabled while this session lives (one owner per extension across processes) and re-reads the marks
 * on each change. Nothing is made unless the person has added an extension: a folder with none costs a
 * `stat`.
 */
export function useExtensionIndicators(): readonly IndicatorView[] {
	const [marks, setMarks] = useState<readonly IndicatorView[]>([])
	useEffect(() => {
		let active = true
		let off: (() => void) | undefined
		let shared: ReturnType<typeof sharedExtensionHost> | undefined
		try {
			if (!existsSync(join(namzuHomePath(), 'extensions'))) return
			const host = sharedExtensionHost('cli')
			shared = host
			const read = () => {
				if (active) setMarks(host.list().flatMap((v) => (v.indicator ? [v.indicator] : [])))
			}
			off = onExtensionState(read)
			host.startSupervision()
			read()
		} catch {
			// a broken extensions folder never takes the terminal down
		}
		return () => {
			active = false
			off?.()
			// The session is closing: stop what it was running, cleanly.
			void shared?.stopSupervision()
		}
	}, [])
	return marks
}
