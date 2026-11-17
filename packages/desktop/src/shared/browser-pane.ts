/** What the renderer and the host say to each other about the Browser pane. */

export interface BrowserTabView {
	id: string
	/** The page's title, or its address while it has none. */
	title: string
	/** What the address bar shows: the whole local path of a file, or the web address. */
	address: string
	loading: boolean
	canGoBack: boolean
	canGoForward: boolean
}

export interface BrowserPaneState {
	sessionId: string
	tabs: BrowserTabView[]
	active?: string
	/** Plain words when the last address was refused; cleared by the next one that works. */
	notice?: string
	/**
	 * A picture of the active page, kept while a menu or dialog lies over the pane: the page itself is
	 * a view above the app's own page and would hide the menu, so it steps aside and this stands in.
	 */
	still?: string
}

export interface BrowserBounds {
	x: number
	y: number
	width: number
	height: number
}

export type BrowserPaneRequest =
	/** A page the conversation wrote: a path as the receipts name it, relative or absolute. */
	| { kind: 'open'; path: string }
	| { kind: 'new'; address?: string }
	/** An address typed into the bar. */
	| { kind: 'go'; address: string }
	| { kind: 'select'; tabId: string }
	| { kind: 'close'; tabId: string }
	| { kind: 'back' }
	| { kind: 'forward' }
	| { kind: 'reload' }
	| { kind: 'state' }
	/** Where the active page is laid in the window, in CSS pixels; null takes it off the screen. */
	| { kind: 'place'; bounds: BrowserBounds | null }
	/** Something lies over the pane: take a picture of the page, then take the page off the screen. */
	| { kind: 'freeze' }

const text = (value: unknown, max: number): string => {
	if (typeof value !== 'string' || value.length > max) throw new Error('Invalid browser request.')
	return value
}

/** Reads a request from the renderer, which is not trusted: anything else is refused. */
export function readBrowserRequest(value: unknown): BrowserPaneRequest {
	if (!value || typeof value !== 'object') throw new Error('Invalid browser request.')
	const request = value as Record<string, unknown>
	switch (request.kind) {
		case 'open':
			return { kind: 'open', path: text(request.path, 4096) }
		case 'new':
			return request.address === undefined
				? { kind: 'new' }
				: { kind: 'new', address: text(request.address, 4096) }
		case 'go':
			return { kind: 'go', address: text(request.address, 4096) }
		case 'select':
		case 'close':
			return { kind: request.kind, tabId: text(request.tabId, 100) }
		case 'back':
		case 'forward':
		case 'reload':
		case 'state':
		case 'freeze':
			return { kind: request.kind }
		case 'place': {
			if (request.bounds === null) return { kind: 'place', bounds: null }
			const bounds = request.bounds as Record<string, unknown> | undefined
			const numbers = ['x', 'y', 'width', 'height'].map((key) => bounds?.[key])
			if (
				!numbers.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100000)
			)
				throw new Error('Invalid browser request.')
			const [x, y, width, height] = numbers as number[]
			return {
				kind: 'place',
				bounds: {
					x: x as number,
					y: y as number,
					width: width as number,
					height: height as number,
				},
			}
		}
		default:
			throw new Error('Invalid browser request.')
	}
}
