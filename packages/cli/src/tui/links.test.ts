import { describe, expect, it } from 'vitest'

import {
	type FileWorld,
	type LinkHost,
	activateLink,
	createLinkFinder,
	editorFor,
	findLinks,
} from './links.js'

const world = (files: readonly string[]): FileWorld => ({
	cwd: '/work/app',
	isFile: (absolute) => files.includes(absolute),
})
const FILES = ['/work/app/src/parse.js', '/work/app/README.md']

describe('finding links in a line', () => {
	it('finds a web address and leaves the sentence punctuation after it out', () => {
		const text = 'See https://example.com/docs/report, then (https://a.dev/x_(y)) and https://b.io.'
		const found = findLinks(text, world([])).map((s) => s.link.target)
		expect(found).toEqual([
			'https://example.com/docs/report',
			'https://a.dev/x_(y)',
			'https://b.io',
		])
	})

	it('reports where each link stands', () => {
		const text = 'go to https://example.com now'
		const [span] = findLinks(text, world([]))
		expect(text.slice(span?.from, span?.to)).toBe('https://example.com')
	})

	it('finds a file in the project with its line and column', () => {
		const text = 'the parser fails at src/parse.js:12:3 and in README.md'
		const spans = findLinks(text, world(FILES))
		expect(spans.map((s) => s.link)).toEqual([
			{
				kind: 'path',
				target: '/work/app/src/parse.js',
				written: 'src/parse.js',
				line: 12,
				column: 3,
			},
			{ kind: 'path', target: '/work/app/README.md', written: 'README.md' },
		])
		expect(text.slice(spans[0]?.from, spans[0]?.to)).toBe('src/parse.js:12:3')
	})

	it('takes only paths that exist inside the project', () => {
		const text = 'v1.2.3 missing.js ../escape.js /etc/hosts.conf src/parse.js'
		const spans = findLinks(text, { cwd: '/work/app', isFile: () => true })
		// the file check says yes to everything; the folder rule still keeps the outside paths out
		expect(spans.map((s) => (s.link.kind === 'path' ? s.link.written : s.link.target))).toEqual([
			'missing.js',
			'src/parse.js',
		])
		expect(findLinks('v1.2.3 missing.js ../escape.js', world(FILES))).toEqual([])
	})

	it('does not read the path inside an address as a second link', () => {
		const spans = findLinks('https://example.com/src/parse.js:12', world(FILES))
		expect(spans).toHaveLength(1)
		expect(spans[0]?.link.kind).toBe('url')
	})

	it('remembers a line for a moment and asks again after it', () => {
		let calls = 0
		let at = 0
		const find = createLinkFinder(
			{
				cwd: '/work/app',
				isFile: () => {
					calls++
					return true
				},
			},
			() => at,
		)
		find('open README.md')
		find('open README.md')
		expect(calls).toBe(1)
		at = 10_000
		find('open README.md')
		expect(calls).toBe(2)
	})
})

describe('choosing an editor', () => {
	const which = (names: readonly string[]) => (name: string) =>
		names.includes(name) ? `/bin/${name}` : null

	it('uses VISUAL first, then EDITOR, and gives a window editor the line', () => {
		expect(
			editorFor('/w/a.ts', 5, undefined, { VISUAL: 'code -r', EDITOR: 'nano' }, which([])),
		).toEqual({
			command: 'code',
			args: ['-r', '--goto', '/w/a.ts:5'],
		})
		expect(editorFor('/w/a.ts', 5, 2, { EDITOR: 'zed' }, which([]))).toEqual({
			command: 'zed',
			args: ['/w/a.ts:5:2'],
		})
		expect(editorFor('/w/a.ts', undefined, undefined, { EDITOR: 'gedit' }, which([]))).toEqual({
			command: 'gedit',
			args: ['/w/a.ts'],
		})
	})

	it('passes over an editor that draws in the terminal and uses one that opens a window', () => {
		expect(editorFor('/w/a.ts', 5, undefined, { EDITOR: 'vim' }, which(['cursor']))).toEqual({
			command: '/bin/cursor',
			args: ['--goto', '/w/a.ts:5'],
		})
	})

	it('has none when nothing can be started', () => {
		expect(editorFor('/w/a.ts', 5, undefined, { EDITOR: 'nvim' }, which([]))).toBeNull()
		expect(editorFor('/w/a.ts', 5, undefined, {}, which([]))).toBeNull()
	})
})

describe('what a click on a link says and does', () => {
	function host(over: Partial<LinkHost> = {}) {
		const opened: string[] = []
		const launched: string[][] = []
		const value: LinkHost = {
			env: {},
			openUrl: (url) => {
				opened.push(url)
				return true
			},
			launch: (command, args) => {
				launched.push([command, ...args])
				return true
			},
			which: () => null,
			show: (absolute) => absolute.replace('/work/app/', ''),
			...over,
		}
		return { value, opened, launched }
	}
	const url = { kind: 'url', target: 'https://example.com/x' } as const
	const file = {
		kind: 'path',
		target: '/work/app/src/parse.js',
		written: 'src/parse.js',
		line: 12,
	} as const

	it('a plain click on an address only says how to open it', () => {
		const h = host()
		expect(activateLink(url, 'hint', h.value)).toEqual({
			text: 'Ctrl+click opens this link in your browser.',
			ok: true,
		})
		expect(h.opened).toEqual([])
	})

	it('a ctrl-click hands the address to the browser', () => {
		const h = host()
		expect(activateLink(url, 'open', h.value).ok).toBe(true)
		expect(h.opened).toEqual(['https://example.com/x'])
	})

	it('shows the address when no browser could be started', () => {
		const h = host({ openUrl: () => false })
		expect(activateLink(url, 'open', h.value)).toEqual({
			text: "Couldn't open your browser. Open https://example.com/x yourself.",
			ok: false,
		})
	})

	it('a ctrl-click on a file starts the editor at the line, with no shell', () => {
		const h = host({ env: { VISUAL: 'code' } })
		expect(activateLink(file, 'open', h.value)).toEqual({
			text: 'Opening src/parse.js:12',
			ok: true,
		})
		expect(h.launched).toEqual([['code', '--goto', '/work/app/src/parse.js:12']])
	})

	it('shows the path to copy when there is no editor, or it would not start', () => {
		const none = host()
		const noEditor = activateLink(file, 'open', none.value)
		expect(noEditor.ok).toBe(false)
		expect(noEditor.text).toContain('The path is src/parse.js:12')
		const broken = host({ env: { VISUAL: 'code' }, launch: () => false })
		expect(activateLink(file, 'open', broken.value).text).toContain('The path is src/parse.js:12')
		expect(activateLink(file, 'hint', none.value).text).toBe(
			'Ctrl+click opens src/parse.js:12 in your editor.',
		)
	})
})
