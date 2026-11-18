import type { BrowserWindow, Session, WebContentsView } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserCookieScope } from '../shared/settings-protocol.js'
import { BrowserPaneHost, partitionOf } from './browser-pane.js'

type Before = (
	details: { url: string; webContentsId?: number },
	callback: (response: { cancel: boolean }) => void,
) => void

/** A page whose only job is to be a view with an id and a partition. */
function fakeView(id: number, partition: string): WebContentsView {
	const contents = {
		id,
		partition,
		getURL: () => '',
		on: () => undefined,
		setWindowOpenHandler: () => undefined,
		loadURL: () => Promise.resolve(),
		close: () => undefined,
		navigationHistory: { canGoBack: () => false, canGoForward: () => false },
	}
	return { webContents: contents } as unknown as WebContentsView
}

function setup(workFolders: Record<string, string>) {
	let scope: BrowserCookieScope = 'quit'
	let next = 1
	const requests = new Map<string, Before>()
	const views: WebContentsView[] = []
	const host = new BrowserPaneHost({
		window: {
			isDestroyed: () => false,
			contentView: { addChildView: () => undefined, removeChildView: () => undefined },
		} as unknown as BrowserWindow,
		createView: (partition) => {
			const view = fakeView(next++, partition)
			views.push(view)
			return view
		},
		sessionOf: (partition) =>
			({
				setPermissionRequestHandler: () => undefined,
				setPermissionCheckHandler: () => undefined,
				setDevicePermissionHandler: () => undefined,
				on: () => undefined,
				webRequest: { onBeforeRequest: (handler: Before) => requests.set(partition, handler) },
			}) as unknown as Session,
		workFolder: (sessionId) => workFolders[sessionId],
		caseless: false,
		send: () => undefined,
		cookieScope: () => scope,
	})
	return {
		host,
		requests,
		views,
		scope: (value: BrowserCookieScope) => {
			scope = value
		},
		partitions: () =>
			views.map((view) => (view.webContents as unknown as { partition: string }).partition),
	}
}

describe('the partition a browser tab lives in', () => {
	it('is one shared partition until the app quits, a persistent one across restarts, one per conversation otherwise', () => {
		expect(partitionOf('quit', 'a')).toBe(partitionOf('quit', 'b'))
		expect(partitionOf('quit', 'a')).not.toMatch(/^persist:/)
		expect(partitionOf('restarts', 'a')).toBe('persist:namzu-browser')
		expect(partitionOf('restarts', 'a')).toBe(partitionOf('restarts', 'b'))
		expect(partitionOf('conversation', 'a')).not.toBe(partitionOf('conversation', 'b'))
		expect(partitionOf('conversation', 'a')).not.toMatch(/^persist:/)
		expect(partitionOf('conversation', 'a')).not.toBe(partitionOf('quit', 'a'))
	})

	it('is chosen when a tab is made, so a change reaches new tabs and leaves open ones alone', () => {
		const pane = setup({})
		pane.host.handle('a', { kind: 'new' })
		pane.scope('restarts')
		pane.host.handle('a', { kind: 'new' })
		pane.scope('conversation')
		pane.host.handle('a', { kind: 'new' })
		pane.host.handle('b', { kind: 'new' })
		const [first, second, third, fourth] = pane.partitions()
		expect(first).toBe(partitionOf('quit', 'a'))
		expect(second).toBe('persist:namzu-browser')
		expect(third).toBe(partitionOf('conversation', 'a'))
		expect(fourth).toBe(partitionOf('conversation', 'b'))
		expect(third).not.toBe(fourth)
	})
})

describe('files on a partition that conversations share', () => {
	it('are judged by the work folder of the conversation whose tab asked', () => {
		const pane = setup({ a: '/work/a', b: '/work/b' })
		pane.host.handle('a', { kind: 'new' })
		pane.host.handle('b', { kind: 'new' })
		const shared = pane.requests.get(partitionOf('quit', 'a'))
		expect(shared).toBeDefined()
		const answer = (url: string, webContentsId?: number) => {
			const callback = vi.fn()
			;(shared as Before)(
				{ url, ...(webContentsId === undefined ? {} : { webContentsId }) },
				callback,
			)
			return callback.mock.calls[0]?.[0].cancel
		}
		// The first view belongs to conversation a, the second to b.
		expect(answer('file:///work/a/index.html', 1)).toBe(false)
		expect(answer('file:///work/b/index.html', 1)).toBe(true)
		expect(answer('file:///work/b/index.html', 2)).toBe(false)
		expect(answer('file:///work/a/index.html', 2)).toBe(true)
		// A request from no known tab may load no file; the web is open to all.
		expect(answer('file:///work/a/index.html')).toBe(true)
		expect(answer('https://example.com/', 1)).toBe(false)
	})
})
