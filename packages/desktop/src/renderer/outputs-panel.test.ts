import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { outputCardKind } from '../shared/output-files.js'
import type { OutputFile } from './outputs-model.js'
import { OutputPreview, OutputsPanel } from './outputs-panel.js'

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
		expect(out).toContain('Outline')
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
	it('offers the browser only for a page, and the folder for every file', () => {
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
		const page = render(file('index.html', 'html'))
		expect(page).toContain('Open in browser')
		expect(page).toContain('Show in folder')
		const doc = render(file('plan.md', 'markdown'))
		expect(doc).not.toContain('Open in browser')
		expect(doc).toContain('Show in folder')
		// A document and a page open in the system's own app; source code does not.
		expect(doc).toContain('Open in app')
		expect(render(file('main.ts', 'code'))).not.toContain('Open in app')
	})
	it('shows the path in a read-only address line, relative to the work folder', () => {
		const view = file('index.html', 'html')
		const out = renderToStaticMarkup(
			createElement(OutputsPanel, {
				api,
				sessionId: 's',
				outputs: [view],
				selected: view.path,
				onSelect: noop,
				dark: false,
				onNotice: noop,
				workFolder: view.path.slice(0, view.path.lastIndexOf('/')),
			}),
		)
		expect(out).toContain('data-output-address')
		expect(out).toMatch(/<input[^>]*readOnly=""|<input[^>]*readonly=""/)
		expect(out).toContain('value="index.html"')
	})
})
