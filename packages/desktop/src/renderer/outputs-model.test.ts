import type { AcpSessionUpdate } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { outputCardKind } from '../shared/output-files.js'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import {
	type OutputFile,
	opensInBrowser,
	outputAddress,
	outputFiles,
	outputForLink,
	outputToOpen,
	previewKind,
} from './outputs-model.js'

function turn(thread: ThreadState, prompt: string): ThreadState {
	return applyEvent(applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt, at: 1000 }), {
		kind: 'state',
		sessionId: 's',
		running: true,
		queued: [],
	})
}
function wrote(
	thread: ThreadState,
	id: string,
	path: string,
	before: string,
	after: string,
): ThreadState {
	const update = (status: 'pending' | 'completed'): AcpSessionUpdate => ({
		kind: 'tool_call',
		toolCallId: id,
		title: 'write',
		status,
		view: { kind: 'diff', path, before, after },
		...(status === 'completed'
			? {
					facts: {
						kind: 'write',
						path,
						operation: before ? 'updated' : 'created',
						added: 3,
						removed: 0,
					},
				}
			: {}),
	})
	let next = applyEvent(thread, {
		kind: 'update',
		sessionId: 's',
		projectId: 'p',
		update: update('pending'),
	})
	next = applyEvent(next, {
		kind: 'update',
		sessionId: 's',
		projectId: 'p',
		update: update('completed'),
	})
	return next
}

describe('what a conversation wrote', () => {
	it('lists each written file once, newest turn first, with a kind', () => {
		let thread = turn(emptyThread(), 'make a page')
		thread = wrote(thread, 'a', 'cafe/index.html', '', '<h1>hi</h1>\n')
		thread = wrote(thread, 'b', 'notes/plan.md', '', '# plan\n')
		thread = turn(thread, 'again')
		thread = wrote(thread, 'c', 'cafe/index.html', '<h1>hi</h1>\n', '<h1>hello</h1>\n')
		const outputs = outputFiles(thread)
		expect(outputs.map((file) => `${file.name}:${file.kind}:${file.turn}`)).toEqual([
			'index.html:html:2',
			'plan.md:markdown:1',
		])
		const page = outputs[0]
		expect(page?.version).toBe(2)
		expect(page?.created).toBe(true)
		expect(page?.folder).toBe('cafe')
	})

	it('classifies by extension', () => {
		expect(previewKind('a/B.HTML')).toBe('html')
		expect(previewKind('x.md')).toBe('markdown')
		expect(previewKind('x.png')).toBe('image')
		expect(previewKind('x.ts')).toBe('code')
		expect(previewKind('Makefile')).toBe('code')
	})

	it('leaves out the files of a turn that was put back', () => {
		let thread = turn(emptyThread(), 'make a page')
		thread = wrote(thread, 'a', 'index.html', '', '<p>x</p>\n')
		expect(outputFiles(thread)).toHaveLength(1)
		const undone = {
			...thread,
			turns: { ...thread.turns, 1: { ...thread.turns[1], turnId: 't1' } },
			undo: { t1: { status: 'undone' } },
		} as unknown as ThreadState
		expect(outputFiles(undone)).toHaveLength(0)
	})
})

describe('what opens by itself', () => {
	const file = (path: string, version: number, kind: 'html' | 'markdown' | 'code') => ({
		path,
		name: path,
		folder: '',
		kind,
		turn: 1,
		version,
		created: true,
		cardKind: outputCardKind(path),
	})
	it('picks a page or document written or changed since it was last seen, not code', () => {
		const outputs = [
			file('a.ts', 3, 'code'),
			file('b.html', 2, 'html'),
			file('c.md', 1, 'markdown'),
		]
		expect(outputToOpen(outputs, new Map())?.path).toBe('b.html')
		expect(outputToOpen(outputs, new Map([['b.html', 2]]))?.path).toBe('c.md')
		expect(
			outputToOpen(
				outputs,
				new Map([
					['b.html', 2],
					['c.md', 1],
				]),
			),
		).toBeUndefined()
		expect(outputToOpen(outputs, new Map([['b.html', 1]]))?.path).toBe('b.html')
	})
})

describe('what opens by itself', () => {
	it('includes a picture, and sends a page and a picture to the Browser pane but a document elsewhere', () => {
		const file = (path: string, kind: 'html' | 'markdown' | 'image' | 'code') => ({
			path,
			name: path,
			folder: '',
			kind,
			cardKind: outputCardKind(path),
			turn: 1,
			version: 1,
			created: true,
		})
		expect(outputToOpen([file('a.png', 'image')], new Map())?.path).toBe('a.png')
		expect(opensInBrowser('html')).toBe(true)
		expect(opensInBrowser('image')).toBe(true)
		expect(opensInBrowser('markdown')).toBe(false)
		expect(opensInBrowser('code')).toBe(false)
	})
})

describe('the address line', () => {
	it('shows a file inside the work folder from the folder', () => {
		expect(outputAddress('/home/a/cafe/site/index.html', '/home/a/cafe')).toBe('site/index.html')
		expect(outputAddress('/home/a/cafe/index.html', '/home/a/cafe/')).toBe('index.html')
		expect(outputAddress('C:\\Users\\a\\cafe\\index.html', 'c:/users/a/cafe')).toBe('index.html')
	})
	it('shows any other path in full', () => {
		expect(outputAddress('/home/a/cafe2/index.html', '/home/a/cafe')).toBe(
			'/home/a/cafe2/index.html',
		)
		expect(outputAddress('/tmp/x.html', '/home/a/cafe')).toBe('/tmp/x.html')
		expect(outputAddress('/home/a/cafe', '/home/a/cafe')).toBe('/home/a/cafe')
		expect(outputAddress('/tmp/x.html')).toBe('/tmp/x.html')
	})
})

describe('files a command made', () => {
	it('counts a made file that no receipt names, once, under the turn that made it', () => {
		let thread = turn(emptyThread(), 'make a page and a chart')
		thread = wrote(thread, 'a', 'cafe/index.html', '', '<h1>hi</h1>\n')
		const list = outputFiles(thread, [
			{ path: '/work/cafe/index.html', turn: 0 },
			{ path: '/work/chart.png', turn: 0 },
		])
		expect(list.map((item) => item.name).sort()).toEqual(['chart.png', 'index.html'])
		const chart = list.find((item) => item.name === 'chart.png')
		expect(chart).toMatchObject({ made: true, cardKind: 'image', created: true })
		expect(list.find((item) => item.name === 'index.html')?.made).toBeUndefined()
	})
})

describe('a link in a reply to a document the conversation wrote', () => {
	const entry = (path: string): OutputFile => ({
		path,
		name: path.split('/').pop() ?? path,
		folder: '',
		kind: previewKind(path),
		turn: 1,
		version: 1,
		created: true,
		cardKind: outputCardKind(path),
	})
	const outputs = [
		entry('/work/docs/Kickoff.md'),
		entry('/work/src/a.ts'),
		entry('/work/page.html'),
	]
	it('finds the document from the folder the link is written from', () => {
		expect(outputForLink(outputs, 'docs/Kickoff.md')?.path).toBe('/work/docs/Kickoff.md')
		expect(outputForLink(outputs, './docs/Kickoff.md')?.path).toBe('/work/docs/Kickoff.md')
		expect(outputForLink(outputs, '/work/docs/Kickoff.md')?.path).toBe('/work/docs/Kickoff.md')
		expect(outputForLink(outputs, 'page.html')?.path).toBe('/work/page.html')
	})
	it('does not match a part of a name, source code, or a file nobody wrote', () => {
		expect(outputForLink(outputs, 'Kickoff.md')?.path).toBe('/work/docs/Kickoff.md')
		expect(outputForLink(outputs, 'off.md')).toBeUndefined()
		expect(outputForLink(outputs, 'src/a.ts')).toBeUndefined()
		expect(outputForLink(outputs, 'other.md')).toBeUndefined()
		expect(outputForLink(outputs, '')).toBeUndefined()
	})
})
