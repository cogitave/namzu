/**
 * In the fullscreen view with the pointer reported in full: a web address or a project file in a
 * reply opens on ctrl-click (or alt-click), a plain click says how, the link is underlined while
 * the pointer rests on it, and where the terminal takes links the text is sent as one. Driven by
 * pointer reports on an emulated screen.
 */

import { Box } from 'ink'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Colour on, so an underline can be told from none.
vi.hoisted(() => {
	process.env.FORCE_COLOR = '3'
})

import { FullscreenTranscript } from '../fullscreen/FullscreenTranscript.js'
import type { CopyReport, FullscreenControl } from '../fullscreen/FullscreenTranscript.js'
import type { PointerReport } from '../fullscreen/mouse-wheel.js'
import { type FoundLink, createLinkFinder } from '../links.js'
import { setReducedMotion } from '../motion.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const COLS = 60
const ROWS = 14
const URL = 'https://example.com/docs/report'

beforeEach(() => {
	setReducedMotion(true)
})
afterEach(async () => {
	setReducedMotion(false)
	await mounted?.unmount()
	mounted = null
})
let mounted: Screen | null = null

const reply = (content: string): TranscriptMessage => ({ id: 'a1', role: 'assistant', content })

async function mount(content: string, options: { hyperlinks?: boolean } = {}) {
	const listeners = new Set<(report: PointerReport) => void>()
	const control: { current: FullscreenControl | null } = { current: null }
	const acted: Array<{ link: FoundLink; how: string }> = []
	const notes: CopyReport[] = []
	const find = createLinkFinder({ cwd: '/w', isFile: (abs) => abs === '/w/src/parse.js' })
	const screen = await renderToScreen(
		<Box flexDirection="column" height={ROWS - 1} paddingLeft={0} paddingRight={1}>
			<FullscreenTranscript
				messages={[reply(content)]}
				pending={null}
				columns={COLS - 2}
				maxRows={ROWS - 1}
				keysActive
				homeEndActive
				subscribeWheel={() => () => undefined}
				subscribePointer={(listener) => {
					listeners.add(listener)
					return () => void listeners.delete(listener)
				}}
				links={{
					find,
					activate: (link, how) => {
						acted.push({ link, how })
						return { text: `${how} ${link.target}`, ok: true }
					},
				}}
				hyperlinks={options.hyperlinks === true}
				onNote={(report) => notes.push(report)}
				control={control}
			/>
		</Box>,
		{ cols: COLS, rows: ROWS, alternateScreen: true, incrementalRendering: true },
	)
	mounted = screen
	await screen.waitForRender()
	const at = (text: string) => {
		const y = screen.viewport().findIndex((row) => row.includes(text)) + 1
		return { y, x: (screen.viewport()[y - 1]?.indexOf(text) ?? -1) + 1 }
	}
	const send = async (report: PointerReport) => {
		for (const listener of listeners) listener(report)
		await screen.waitForRender()
	}
	const click = async (x: number, y: number, mods: Partial<PointerReport> = {}) => {
		await send({ kind: 'press', x, y, ...mods })
		await send({ kind: 'release', x, y, ...mods })
	}
	return { screen, at, send, click, acted, notes }
}

it('opens an address on ctrl-click and does not select it', async () => {
	const m = await mount(`Docs are at ${URL} today.`)
	const link = m.at('https://')
	await m.click(link.x + 4, link.y, { ctrl: true })
	expect(m.acted).toEqual([{ link: { kind: 'url', target: URL }, how: 'open' }])
	expect(m.notes.map((n) => n.text)).toEqual([`open ${URL}`])
})

it('opens a project file at its line on alt-click', async () => {
	const m = await mount('The fix is in src/parse.js:12 now.')
	const file = m.at('src/parse.js')
	await m.click(file.x + 2, file.y, { alt: true })
	expect(m.acted).toEqual([
		{
			link: {
				kind: 'path',
				target: '/w/src/parse.js',
				written: 'src/parse.js',
				line: 12,
			},
			how: 'open',
		},
	])
})

it('says how to open a link on a plain click, and opens nothing', async () => {
	const m = await mount(`Docs are at ${URL} today.`)
	const link = m.at('https://')
	await m.click(link.x + 4, link.y)
	expect(m.acted.map((a) => a.how)).toEqual(['hint'])
})

it('does nothing for a click beside a link, or for a path that is not a file of the project', async () => {
	const m = await mount('Docs are at https://example.com/x today, not in other.js:3.')
	const word = m.at('Docs')
	await m.click(word.x, word.y, { ctrl: true })
	const other = m.at('other.js')
	await m.click(other.x, other.y, { ctrl: true })
	expect(m.acted).toEqual([])
})

it('reads an address the wrap cut across rows as one link', async () => {
	const long = `${URL}/${'section-'.repeat(8)}end`
	const m = await mount(`See ${long} please.`)
	const second = m.screen.viewport().findIndex((row) => row.includes('end')) + 1
	expect(second).toBeGreaterThan(0)
	await m.click(m.at('end').x, second, { ctrl: true })
	expect(m.acted).toHaveLength(1)
	expect(m.acted[0]?.link).toEqual({ kind: 'url', target: long })
})

it('underlines the link under the pointer, once, and lets go when the pointer leaves', async () => {
	const m = await mount(`Docs are at ${URL} today.`)
	const link = m.at('https://')
	const before = m.screen.writes().length
	await m.send({ kind: 'move', x: link.x + 3, y: link.y })
	const underline = '\u001b[4m'
	const lit = m.screen.writes().slice(before).join('')
	expect(lit).toContain(underline)
	// moving inside the same link repaints nothing
	const settled = m.screen.writes().length
	await m.send({ kind: 'move', x: link.x + 6, y: link.y })
	await m.send({ kind: 'move', x: link.x + 7, y: link.y })
	expect(m.screen.writes().slice(settled).join('')).toBe('')
	// off the link the underline goes
	const off = m.screen.writes().length
	await m.send({ kind: 'move', x: 1, y: 1 })
	expect(m.screen.writes().length).toBeGreaterThan(off)
})

it('sends the link text as a terminal hyperlink where the terminal takes them', async () => {
	const withLinks = await mount(`Docs are at ${URL} today.`, { hyperlinks: true })
	expect(withLinks.screen.writes().join('')).toContain(`\u001b]8;;${URL}\u001b\\`)
	// the row still reads as the text and holds its place
	expect(withLinks.screen.viewport().join('\n')).toContain(`Docs are at ${URL} today.`)
})

it('sends no hyperlink sequence where the terminal does not take them', async () => {
	const plain = await mount(`Docs are at ${URL} today.`)
	expect(plain.screen.writes().join('')).not.toContain('\u001b]8;;')
})
