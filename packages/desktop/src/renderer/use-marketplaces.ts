import { useCallback, useEffect, useRef, useState } from 'react'
import type {
	MarketplaceAvailableView,
	MarketplaceListView,
	OpProgressView,
} from '../shared/customize-protocol.js'
import type { DesktopApi } from '../shared/protocol.js'
import { plainErrorText } from './plain-error.js'
import { PLUGINS_CHANGED_EVENT } from './plugin-create.js'

type Bridge = Pick<DesktopApi, 'marketplaces' | 'availablePlugins'>

export interface Marketplaces {
	/** Undefined until the first answer, and from an engine that cannot manage marketplaces. */
	view?: MarketplaceListView
	/** Each marketplace's plugins, read only while the Discover view is open. */
	available: Readonly<Record<string, MarketplaceAvailableView | { error: string }>>
	error?: string
	reload: () => void
}

/**
 * The marketplaces the person added, read when the Plugins tab is open and again when a plugin or
 * marketplace changed; and, while `discover` is true, what each one offers.
 */
export function useMarketplaces(
	api: Bridge | undefined,
	projectId: string | undefined,
	active: boolean,
	discover: boolean,
): Marketplaces {
	const [view, setView] = useState<MarketplaceListView>()
	const [error, setError] = useState<string>()
	const [available, setAvailable] = useState<Marketplaces['available']>({})
	const [tick, setTick] = useState(0)
	const latest = useRef(0)
	const reload = useCallback(() => setTick((n) => n + 1), [])
	useEffect(() => {
		const on = () => reload()
		window.addEventListener(PLUGINS_CHANGED_EVENT, on)
		return () => window.removeEventListener(PLUGINS_CHANGED_EVENT, on)
	}, [reload])
	// biome-ignore lint/correctness/useExhaustiveDependencies: tick is the reload request
	useEffect(() => {
		if (!api?.marketplaces || !active) return
		const mine = ++latest.current
		void (async () => {
			try {
				const list = await api.marketplaces?.(projectId)
				if (latest.current !== mine) return
				setView(list ?? undefined)
				setError(undefined)
				if (!list || !discover || !api.availablePlugins) return
				const entries = await Promise.all(
					list.marketplaces.map(async (market) => {
						try {
							const read = await api.availablePlugins?.(market.name, projectId)
							return [
								market.name,
								read ?? { error: 'Update Namzu to read this marketplace.' },
							] as const
						} catch (failure) {
							return [
								market.name,
								{ error: plainErrorText(failure, 'read the marketplace') },
							] as const
						}
					}),
				)
				if (latest.current === mine) setAvailable(Object.fromEntries(entries))
			} catch (failure) {
				if (latest.current === mine) setError(plainErrorText(failure, 'read the marketplaces'))
			}
		})()
	}, [api, projectId, active, discover, tick])
	return { view, available, error, reload }
}

/** The phase a long step is in, by the id the window named it with; undefined when none is running. */
export function useOpPhase(api: Pick<DesktopApi, 'onEvent'> | undefined, opId: string | undefined) {
	const [phase, setPhase] = useState<OpProgressView['phase']>()
	useEffect(() => {
		setPhase(undefined)
		if (!api || !opId) return
		return api.onEvent((event) => {
			if (event.kind === 'op-progress' && event.opId === opId) setPhase(event.phase)
		})
	}, [api, opId])
	return phase
}
