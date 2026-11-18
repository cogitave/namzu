import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { outputCardKind } from '../shared/output-files.js'
import type { OutputFile } from './outputs-model.js'
import {
	OUTPUT_ACTION_LABEL,
	OutputPreview,
	OutputsPanel,
	outputMenuActions,
} from './outputs-panel.js'

const file = (name: string, kind: OutputFile['kind']): OutputFile => ({
	path: `cafe/${name}`,
	name,
	folder: 'cafe',
	kind,
	turn: 1,
	version: 1,
	created: true,
	cardKind: outputCardKind(name),
})
const noop = () => {}
const html = (view: OutputFile, text: string, kind: 'text' | 'image' = 'text') =>
	renderToStaticMarkup(
		createElement(OutputPreview, {
			file: view,
			dark: false,
			content: {
				path: view.path,
				size: text.length,
				kind,
				...(kind === 'text' ? { text } : { image: text }),
			},
		}),
	)

describe('the preview of a written file', () => {
	it('draws a page in a frame with no permissions and no network', () => {
		const out = html(
			file('index.html', 'html'),
			'<html><head></head><body><h1>Ada</h1></body></html>',
		)
		expect(out).toContain('<iframe')
		expect(out).toMatch(/\ssandbox=""/)
		expect(out).not.toContain('allow-same-origin')
		expect(out).not.toContain('allow-top-navigation')
		expect(out).toContain('referrerPolicy="no-referrer"')
		// The policy is in the document the frame is given.
		expect(out).toContain('Content-Security-Policy')
		expect(out).toContain('default-src &#x27;none&#x27;')
	})
	it('draws a document as formatted text, not as source', () => {
		const out = html(file('plan.md', 'markdown'), '# Plan\n\n- one\n- two\n')
		expect(out).toContain('data-output-preview="markdown"')
		expect(out).toMatch(/<h1[^>]*>Plan<\/h1>/)
		expect(out).toContain('<li>one</li>')
	})
	it('draws an image as itself and says so for a file that is not text', () => {
		expect(html(file('logo.png', 'image'), 'data:image/png;base64,AAAA', 'image')).toContain(
			'<img src="data:image/png;base64,AAAA"',
		)
		const out = renderToStaticMarkup(
			createElement(OutputPreview, {
				file: file('x.bin', 'code'),
				dark: false,
				content: { path: 'x.bin', size: 5, kind: 'binary' },
			}),
		)
		expect(out).toContain('not text')
	})
})

describe('a document drawn as a page', () => {
	const doc =
		'# Kickoff\n\n## Goals\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n![Chart](img/chart.png)\n\n- [ ] task\n'
	const read = async () => ({ path: 'x', size: 1, kind: 'binary' as const })
	const page = () =>
		renderToStaticMarkup(
			createElement(OutputPreview, {
				file: file('Kickoff.md', 'markdown'),
				dark: false,
				sessionId: 's',
				read,
				content: { path: 'cafe/Kickoff.md', size: doc.length, kind: 'text', text: doc },
			}),
		)
	it('has an outline button, a sheet and tables that scroll sideways', () => {
		const out = page()
		expect(out).toContain('document-page-sheet')
		expect(out).toContain('data-document-outline-button')
		// An icon button: its name is a label, not a word beside the icon.
		expect(out).toContain('aria-label="Outline"')
		expect(out).toContain('class="table-scroll"')
	})
	it('keeps the outline button off a document with no headings', () => {
		const out = renderToStaticMarkup(
			createElement(OutputPreview, {
				file: file('note.md', 'markdown'),
				dark: false,
				content: { path: 'cafe/note.md', size: 3, kind: 'text', text: 'Just a note.' },
			}),
		)
		expect(out).not.toContain('data-document-outline-button')
		expect(out).toContain('Just a note.')
	})
	it('reads a picture the document holds from beside it, and leaves a web picture alone', () => {
		expect(page()).toContain('data-document-image="loading"')
		const web = renderToStaticMarkup(
			createElement(OutputPreview, {
				file: file('w.md', 'markdown'),
				dark: false,
				content: { path: 'cafe/w.md', size: 3, kind: 'text', text: '![Far](https://x.test/a.png)' },
			}),
		)
		expect(web).not.toContain('<img')
		expect(web).toContain('Far')
	})
})

describe('the list', () => {
	const api = { readSessionOutput: undefined, openSessionOutput: undefined }
	it('names each output with its folder and kind', () => {
		const out = renderToStaticMarkup(
			createElement(OutputsPanel, {
				api,
				sessionId: 's',
				outputs: [file('index.html', 'html'), file('plan.md', 'markdown')],
				onSelect: noop,
				dark: false,
				onNotice: noop,
			}),
		)
		expect(out.match(/data-output-row=/g)).toHaveLength(2)
		expect(out).toContain('index.html')
		expect(out).toContain('Page')
		expect(out).toContain('Document')
		expect(out).toContain('cafe')
	})
	it('says what it is for when nothing was written', () => {
		const out = renderToStaticMarkup(
			createElement(OutputsPanel, {
				api,
				sessionId: 's',
				outputs: [],
				onSelect: noop,
				dark: false,
				onNotice: noop,
			}),
		)
		expect(out).toContain('Nothing has been written')
	})
	it('keeps the file actions in the title menu, not as a row of words', () => {
		const render = (view: OutputFile) =>
			renderToStaticMarkup(
				createElement(OutputsPanel, {
					api,
					sessionId: 's',
					outputs: [view],
					selected: view.path,
					onSelect: noop,
					dark: false,
					onNotice: noop,
				}),
			)
		const out = render(file('index.html', 'html'))
		// One header row: the name with its menu, and icon buttons; no address row and no back arrow.
		expect(out).toContain('data-output-header')
		expect(out).toContain('index.html, file actions')
		expect(out).toContain('aria-label="Close file"')
		expect(out).not.toContain('Open in browser')
		expect(out).not.toContain('data-outputs-address-input')
		expect(out).not.toContain('aria-label="All outputs"')
	})
	it('offers the browser only for a page, and the folder and the path for every file', () => {
		const can = { save: true }
		expect(outputMenuActions(file('index.html', 'html'), can)).toEqual([
			'browser',
			'system',
			'folder',
			'save',
			'copy-path',
		])
		const doc = outputMenuActions(file('plan.md', 'markdown'), can)
		expect(doc).not.toContain('browser')
		expect(doc).toEqual(['system', 'folder', 'save', 'copy-path'])
		// Source code does not open in the system's own app, and a host that cannot save offers no copy.
		expect(outputMenuActions(file('main.ts', 'code'), { save: false })).toEqual([
			'folder',
			'copy-path',
		])
		expect(OUTPUT_ACTION_LABEL['copy-path']).toBe('Copy path')
	})
})

describe('the pane', () => {
	it('is one 43 px header row, a 36 px outline button and a 42rem sheet', () => {
		const panel = readFileSync(new URL('./outputs-panel.css', import.meta.url), 'utf8')
		const page = readFileSync(new URL('./document-page.css', import.meta.url), 'utf8')
		expect(panel).toMatch(/\.outputs-preview-bar \{[^}]*height: 43px;/)
		expect(panel).toMatch(/\.output-row \{[^}]*padding: 5px 8px;/)
		expect(page).toMatch(/\.document-outline-trigger \{[^}]*width: 36px;[^}]*height: 36px;/)
		expect(page).toContain('max-width: calc(42rem + 104px)')
		expect(page).toContain('padding: 8px 52px 64px')
		// The file view's own .file-document rule loads later with the same weight: the sheet must out-rank it.
		expect(page).toMatch(/\.file-document\.document-page-sheet \{/)
		// A 16 px mark keeps the row at 30 px, so the 32 px pitch holds.
		expect(panel).toMatch(/\.output-row > svg \{[^}]*width: 1rem;[^}]*height: 1rem;/)
		// The floating button hangs below the bar's top edge; centred in a zero-height bar it was half cut off.
		expect(page).toMatch(/\.document-page-bar \{[^}]*align-items: flex-start;/)
		// Square tables with a line on every cell edge.
		expect(page).toContain('border-collapse: collapse')
		expect(page).toMatch(/th,[^{]*td \{[^}]*border: 1px solid var\(--border-table\)/)
	})
})
