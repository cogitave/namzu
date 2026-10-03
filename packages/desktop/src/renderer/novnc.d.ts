declare module '@novnc/novnc' {
	/** The display-only public noVNC surface used by the desktop viewer. */
	export default class RFB extends EventTarget {
		constructor(target: HTMLElement, channel: string | WebSocket, options?: { shared?: boolean })
		viewOnly: boolean
		focusOnClick: boolean
		scaleViewport: boolean
		resizeSession: boolean
		background: string
		disconnect(): void
	}
}
