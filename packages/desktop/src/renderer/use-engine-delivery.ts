import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { EngineDeliveryView } from '../shared/engine-delivery-protocol.js'
import type { DesktopApi } from '../shared/protocol.js'

export interface EngineDeliveryControls {
	view: EngineDeliveryView
	/** "Use this app's own engine"; takes effect the next time a project opens. */
	chooseOwn: () => Promise<void>
}

export const EngineDeliveryContext = createContext<EngineDeliveryControls | undefined>(undefined)

/**
 * The engine the app runs, or undefined where this window has none to show: a build with no
 * signing key reports an unavailable view, and the screens then draw nothing about it.
 */
export function useEngineDelivery(): EngineDeliveryControls | undefined {
	return useContext(EngineDeliveryContext)
}

/** Reads main's view once and follows its pushes. Returns the function that stops following. */
export function connectEngineDelivery(
	api: Pick<DesktopApi, 'engineDelivery' | 'onEngineDelivery'>,
	set: (view: EngineDeliveryView) => void,
): () => void {
	if (!api.engineDelivery || !api.onEngineDelivery) return () => undefined
	let live = true
	const stop = api.onEngineDelivery((view) => {
		if (live) set(view)
	})
	void api
		.engineDelivery()
		.then((view) => {
			if (live) set(view)
		})
		.catch(() => undefined)
	return () => {
		live = false
		stop()
	}
}

/** The controls a window gets: none when this build cannot fetch engines, so nothing is drawn. */
export function deliveryControls(
	view: EngineDeliveryView | undefined,
	chooseOwn: () => Promise<void>,
): EngineDeliveryControls | undefined {
	return view?.available ? { view, chooseOwn } : undefined
}

export function useEngineDeliveryController(
	api: DesktopApi | undefined,
): EngineDeliveryControls | undefined {
	const [view, setView] = useState<EngineDeliveryView | undefined>()
	useEffect(() => {
		if (!api) return
		return connectEngineDelivery(api, setView)
	}, [api])
	const chooseOwn = useCallback(async () => {
		const next = await api?.useOwnEngine?.()
		if (next) setView(next)
	}, [api])
	return useMemo(() => deliveryControls(view, chooseOwn), [view, chooseOwn])
}
