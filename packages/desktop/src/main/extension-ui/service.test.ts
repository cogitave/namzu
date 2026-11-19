import { describe, expect, it } from 'vitest'
import { originOf } from './policy.js'
import { EngineRefusal, pageBackend, pageSpec, pageState, readUiInfo } from './service.js'

const info = { extensionId: 'com.example.a', pageId: 'today', origin: originOf('com.example.a') }
const good = {
	ui: {
		version: '1.0.0',
		dir: '/home/me/.namzu/extensions/com.example.a/versions/1.0.0',
		accent: '#2F6F4F',
		icon: 'ui/icon.svg',
		pages: [
			{
				id: 'today',
				title: "Today's record",
				slot: 'settings',
				entry: 'ui/pages/today.html',
				minHeight: 360,
				usesNetwork: false,
				bridge: {
					allow: ['query:counts', 'action:pick-day'],
					host: ['theme', 'openNamzu', 'bogus'],
				},
				hosts: [],
			},
		],
		chips: [{ id: 'recording', state: 'gap', label: 'Recording with a gap', tone: 'warn' }],
		files: [
			{ path: 'ui/pages/today.html', sha256: 'a'.repeat(64) },
			{ path: 'bad', sha256: 'zz' },
		],
		methods: [
			{ method: 'query:counts', maxBytes: 4096 },
			{ method: 'action:pick-day', maxBytes: 512 },
		],
	},
}

describe('what the engine says about a page', () => {
	it('is read only when well formed, and a file with a bad hash is left out', () => {
		const u = readUiInfo(good)
		expect(u?.pages).toHaveLength(1)
		expect(u?.files).toEqual([{ path: 'ui/pages/today.html', sha256: 'a'.repeat(64) }])
		expect(u?.chips[0]).toMatchObject({ id: 'recording', state: 'gap' })
		expect(readUiInfo(null)).toBeUndefined()
		expect(readUiInfo({ ui: null })).toBeUndefined()
		expect(readUiInfo({ ui: { dir: 3, pages: [], files: [] } })).toBeUndefined()
	})
	it('the page spec carries only what the manifest declared, and drops a host helper that does not exist', () => {
		const u = readUiInfo(good)
		if (!u) throw new Error('unreadable')
		const s = pageSpec('com.example.a', u, 'today')
		expect(s).toMatchObject({
			extensionId: 'com.example.a',
			entry: 'ui/pages/today.html',
			allow: ['query:counts', 'action:pick-day'],
			host: ['theme', 'openNamzu'],
			maxBytes: { 'query:counts': 4096, 'action:pick-day': 512 },
			usesNetwork: false,
		})
		expect(pageSpec('com.example.a', u, 'nope')).toBeUndefined()
	})
	it('a page is told only the states it knows; anything else reads as stopped', () => {
		expect(pageState('running')).toBe('running')
		expect(pageState('license-grace')).toBe('license-grace')
		expect(pageState('update-waiting')).toBe('stopped')
		expect(pageState({ evil: 1 })).toBe('stopped')
	})
})

describe("a bridge call becomes the engine's own query or action, for this extension only", () => {
	const calls: [string, Record<string, unknown>][] = []
	const mk = (answer: unknown) =>
		pageBackend(
			{
				engine: async (m, p) => {
					calls.push([m, p])
					return answer
				},
				theme: (id) => ({ dark: true, tokens: { '--ns-bg': '#000', id } }),
				locale: () => 'tr',
				state: () => 'running',
				openNamzu: (i, t) => void calls.push(['open', { id: i.extensionId, t }]),
			},
			info,
		)
	it("a query names the extension from the page's registration, with the page's params", async () => {
		calls.length = 0
		expect(await mk({ kind: 'x' }).extension('query:counts', { day: 'today' }, false)).toEqual({
			kind: 'x',
		})
		expect(calls).toEqual([
			[
				'namzu/extensions/query',
				{ id: 'com.example.a', query: 'counts', params: { day: 'today' } },
			],
		])
	})
	it('an action also carries the activation stamp', async () => {
		calls.length = 0
		await mk({ ok: true }).extension('action:pick-day', { day: 'x' }, true)
		expect(calls[0]).toEqual([
			'namzu/extensions/action',
			{ id: 'com.example.a', action: 'pick-day', params: { day: 'x' }, activation: true },
		])
	})
	it("a refusal of the engine becomes an error with its code and nothing else of the page's making", async () => {
		await expect(
			mk({ error: { code: 'R1', message: 'x' } }).extension('query:counts', {}, false),
		).rejects.toMatchObject({ code: 'R1' })
		await expect(
			mk({ error: { code: 'R1' } }).extension('query:counts', {}, false),
		).rejects.toBeInstanceOf(EngineRefusal)
	})
	it('an answer that is a list or a number passes through whole', async () => {
		expect(await mk([1, 2, 3]).extension('query:counts', {}, false)).toEqual([1, 2, 3])
		expect(await mk(null).extension('query:counts', {}, false)).toBeNull()
	})
	it("host helpers: theme, locale, state, and opening only Namzu's own screens", () => {
		const b = mk(null)
		expect(b.theme()).toEqual({ dark: true, tokens: { '--ns-bg': '#000', id: 'com.example.a' } })
		expect(b.locale()).toEqual({ locale: 'tr' })
		expect(b.state()).toEqual({ state: 'running' })
		calls.length = 0
		b.openNamzu('what-is-collected')
		expect(calls).toEqual([['open', { id: 'com.example.a', t: 'what-is-collected' }]])
	})
})
