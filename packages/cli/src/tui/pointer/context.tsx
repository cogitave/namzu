import type { DOMElement } from 'ink'
import { type RefObject, createContext, useContext, useEffect, useRef, useState } from 'react'

import type { PointerReport } from '../fullscreen/mouse-wheel.js'
import { type PointerRegions, elementRect } from './regions.js'

/** The registry of the screen's clickable regions; absent where the pointer is not reported in full. */
export const PointerRegionsContext = createContext<PointerRegions | null>(null)

/** Whether clicks reach regions here: the pointer is reported in full. */
export function usePointerActive(): boolean {
	return useContext(PointerRegionsContext) !== null
}

/**
 * Make the element in `ref` answer the pointer. Returns whether the pointer is over it now; that
 * state changes only when the pointer enters or leaves, so hovering costs no redraw while it
 * stays put. Handlers are read through a ref: a new function each render does not re-register.
 */
export function usePointerRegion(
	ref: RefObject<DOMElement | null>,
	handlers: {
		readonly onClick?: (report: PointerReport) => void
		readonly enabled?: boolean
	},
): boolean {
	const regions = useContext(PointerRegionsContext)
	const [hovered, setHovered] = useState(false)
	const latest = useRef(handlers)
	latest.current = handlers
	const enabled = handlers.enabled !== false
	useEffect(() => {
		if (!regions || !enabled) return undefined
		const off = regions.register({
			rect: () => elementRect(ref.current),
			onClick: (report) => latest.current.onClick?.(report),
			onHover: setHovered,
		})
		return () => {
			off()
			setHovered(false)
		}
	}, [regions, enabled, ref])
	return hovered
}
