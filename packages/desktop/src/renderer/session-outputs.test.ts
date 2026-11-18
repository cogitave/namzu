import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { outputCardKind } from '../shared/output-files.js'
import { ContextInline } from './context-panel.js'
import { DocumentPage } from './document-page.js'
import type { OutputFile } from './outputs-model.js'
import { SessionPanel } from './session-panel.js'
import { sessionSummary } from './session-summary-model.js'

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
const options = { link: () => undefined, image: () => undefined }
const summary = sessionSummary({
	project: { name: 'demo', path: '/work/demo', trusted: true },
	git: null,
	usage: undefined,
	servers: { state: 'hidden' },
	totals: { added: 0, removed: 0, files: 0, cut: false },
	work: { state: 'unavailable' },
})
const panel = (
	outputs?: OutputFile[],
	source?: Parameters<typeof SessionPanel>[0]['contextPanel'],
) =>
	renderToStaticMarkup(
		createElement(SessionPanel, {
			summary,
			jobs: [],
			jobsKnown: true,
			now: 0,
			onClose: noop,
			onOpenChanges: noop,
			onOpenWork: noop,
			outputs,
			onOpenOutput: noop,
			contextPanel: source,
			usage: undefined,
		}),
	)

it('lists the outputs, one row each, with the file name, after the tool servers', () => {
	const out = panel([file('index.html', 'html'), file('plan.md', 'markdown')])
	expect(out).toContain('aria-label="Outputs"')
	expect(out.match(/data-output-row=/g)).toHaveLength(2)
	expect(out.indexOf('index.html')).toBeLessThan(out.indexOf('plan.md'))
	expect(out.indexOf('aria-label="Environment"')).toBeLessThan(out.indexOf('aria-label="Outputs"'))
	expect(out.indexOf('aria-label="Outputs"')).toBeLessThan(out.indexOf('aria-label="Changes"'))
})

it('draws no Outputs section when nothing was made', () => {
	expect(panel([])).not.toContain('aria-label="Outputs"')
	expect(panel(undefined)).not.toContain('aria-label="Outputs"')
})

it('draws the context breakdown inline, in place of the bar, when it can read one', () => {
	const out = panel(undefined, { ask: () => Promise.resolve(null) })
	expect(out).toContain('session-context-section')
	expect(out).toContain('context-panel')
	expect(out).not.toContain('data-testid="session-context"')
})

it('keeps rows 32 px apart', () => {
	const css = readFileSync(new URL('./session-panel.css', import.meta.url), 'utf8')
	expect(css).toMatch(/\.session-output \{[^}]*min-height: 32px;/)
})

it('draws a document as a page with an outline button and tables that scroll sideways', () => {
	const out = renderToStaticMarkup(
		createElement(DocumentPage, {
			text: '# Kickoff\n\n## Goals\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
			options,
		}),
	)
	expect(out).toContain('document-page-sheet')
	expect(out).toContain('data-document-outline-button')
	expect(out).toContain('class="table-scroll"')
	const plain = renderToStaticMarkup(createElement(DocumentPage, { text: 'Just a note.', options }))
	expect(plain).not.toContain('data-document-outline-button')
	expect(plain).toContain('Just a note.')
})

it('keeps the page styles the Files pane relies on', () => {
	const page = readFileSync(new URL('./document-page.css', import.meta.url), 'utf8')
	expect(page).toMatch(/\.document-outline-trigger \{[^}]*width: 36px;[^}]*height: 36px;/)
	expect(page).toContain('max-width: calc(42rem + 104px)')
	expect(page).toMatch(/\.file-document\.document-page-sheet \{/)
	expect(page).toContain('border-collapse: collapse')
})

it('switches a Markdown file between rendered and source in its header', () => {
	const panelSource = readFileSync(new URL('./file-panel/file-panel.tsx', import.meta.url), 'utf8')
	expect(panelSource).toContain('file-view-toggle')
	expect(panelSource).toContain('Rendered')
	expect(panelSource).toContain('Source')
})

it('draws the reserve rows before the deferred ones, as the reference does', () => {
	const out = renderToStaticMarkup(
		createElement(ContextInline, {
			usage: undefined,
			read: {
				loading: false,
				report: {
					detail: 'summary',
					measuredBy: 'provider',
					windowTokens: 1_000_000,
					totalTokens: 50_000,
					percentage: 5,
					autoCompact: { enabled: true, bufferTokens: 33_000, thresholdTokens: 967_000 },
					categories: [
						{ id: 'messages', name: 'Messages', tokens: 50_000, kind: 'used' },
						{ id: 'deferred-tools', name: 'Tools', tokens: 25_300, kind: 'deferred' },
						{ id: 'buffer', name: 'Buffer', tokens: 33_000, kind: 'buffer' },
						{ id: 'free', name: 'Free space', tokens: 889_300, kind: 'free' },
					],
					approximate: false,
				},
			},
		}),
	)
	expect(out.indexOf('Free space')).toBeGreaterThan(0)
	expect(out.indexOf('Free space')).toBeLessThan(out.indexOf('(deferred)'))
})
