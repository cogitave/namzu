import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { JobView, McpServersView } from '../shared/protocol.js'
import { SessionPanel } from './session-panel.js'
import {
	type SessionSummaryInput,
	finishedText,
	jobElapsed,
	sessionSummary,
} from './session-summary-model.js'

const base: SessionSummaryInput = {
	project: { name: 'demo', path: '/work/demo', trusted: true },
	git: { branch: 'main', subject: 'Start' },
	usage: { contextTokens: 70, contextWindowTokens: 1000, measuredBy: 'provider' },
	servers: {
		state: 'known',
		view: {
			servers: [
				{ name: 'files', origin: 'your-config', state: 'connected' },
				{ name: 'docs', origin: 'project-file', state: 'waiting', fingerprint: 'x' },
				{ name: 'bad', origin: 'this-project', state: 'failed', reason: 'no' },
			],
		} as McpServersView,
	},
	totals: { added: 312, removed: 0, files: 2, cut: false },
	work: { state: 'known', running: 1, needsAttention: false, finished: 2 },
}

it('reads the environment, context, tool servers, changes and background work from one input', () => {
	const summary = sessionSummary(base)
	expect(summary.environment.host).toBe('This computer')
	expect(summary.environment.folder).toEqual({ name: 'demo', path: '/work/demo' })
	expect(summary.environment.branch?.text).toBe('main')
	expect(summary.context).toMatchObject({ measured: true, text: '7%', tone: 'normal' })
	expect(summary.toolServers?.label).toBe('Tool servers')
	expect(summary.toolServers?.count).toBe('1 connected')
	expect(summary.toolServers?.attention).toBe('1 needs approval · 1 failed')
	expect(summary.changes).toMatchObject({ hasChanges: true, added: '312', removed: '0' })
	expect(summary.background).toMatchObject({ text: '1 running', finished: 2 })
})

it('never draws a zero for what is not known', () => {
	const none = sessionSummary({
		...base,
		usage: undefined,
		git: null,
		project: { name: 'demo', path: '/work/demo', trusted: false },
		servers: { state: 'untrusted' },
		totals: { added: 0, removed: 0, files: 0, cut: false },
		work: { state: 'unavailable' },
	})
	expect(none.context).toMatchObject({ measured: false, text: 'Not measured yet', fraction: 0 })
	expect(none.environment.branch).toBeUndefined()
	expect(none.environment.branchNote).toBe('Trust this folder to see its branch')
	expect(none.toolServers?.count).toBe('Trust this folder to read them')
	expect(none.changes.hasChanges).toBe(false)
	expect(none.background).toMatchObject({ text: 'Not known', finished: 0 })
	expect(sessionSummary({ ...base, work: { state: 'checking' } }).background.text).toBe('Checking…')
})

it('says "about" when the context is estimated, and names an empty list', () => {
	const estimated = sessionSummary({
		...base,
		usage: { contextTokens: 500, contextWindowTokens: 1000, measuredBy: 'estimate' },
		servers: { state: 'known', view: { servers: [] } },
	})
	expect(estimated.context.text).toBe('about 50%')
	expect(estimated.toolServers?.count).toBe('None')
	expect(sessionSummary({ ...base, servers: { state: 'hidden' } }).toolServers).toBeUndefined()
})

it('shows a detached head by name and an attention state before the running count', () => {
	const summary = sessionSummary({
		...base,
		git: { branch: null, subject: 'abc' },
		work: { state: 'known', running: 2, needsAttention: true },
	})
	expect(summary.environment.branch?.text).toBe('Detached')
	expect(summary.background.text).toBe('Needs attention')
})

it('counts finished jobs and writes running time in the live step words', () => {
	expect(finishedText(0)).toBeUndefined()
	expect(finishedText(1)).toBe('1 finished')
	expect(jobElapsed(1000, 66_000)).toBe('1m 5s')
	expect(jobElapsed(5000, 1000)).toBe('0s')
})

const jobs: JobView[] = [
	{ id: 'a', command: 'sleep 100', status: 'running', startedAt: 0 },
	{ id: 'b', command: 'npm test', status: 'exited', exitCode: 0, startedAt: 0 },
]

it('draws the model rows in the panel', () => {
	const summary = sessionSummary(base)
	const panel = renderToStaticMarkup(
		createElement(SessionPanel, {
			summary,
			jobs,
			jobsKnown: true,
			now: 65_000,
			onClose: () => {},
			onOpenChanges: () => {},
			onOpenWork: () => {},
		}),
	)
	for (const html of [panel]) {
		expect(html).toContain('312')
		expect(html).toContain('main')
	}
	expect(panel).toContain('1m 5s')
	expect(panel).toContain('1 finished')
	expect(panel).toContain('Tool servers')
	expect(panel).toContain('1 connected')
	expect(panel).toContain('7%')
})

it('says None, and Not known, instead of a count the panel cannot stand behind', () => {
	const empty = renderToStaticMarkup(
		createElement(SessionPanel, {
			summary: sessionSummary({
				...base,
				work: { state: 'known', running: 0, needsAttention: false },
			}),
			jobs: [],
			jobsKnown: true,
			now: 0,
			onClose: () => {},
			onOpenChanges: () => {},
			onOpenWork: () => {},
		}),
	)
	expect(empty).toContain('None')
	const unknown = renderToStaticMarkup(
		createElement(SessionPanel, {
			summary: sessionSummary({ ...base, work: { state: 'unavailable' } }),
			jobs: [],
			jobsKnown: false,
			now: 0,
			onClose: () => {},
			onOpenChanges: () => {},
			onOpenWork: () => {},
		}),
	)
	expect(unknown).toContain('Not known')
	expect(unknown).not.toContain('finished')
})

it('draws a chat with no project: This computer first, then Context and Background tasks, no repository rows', () => {
	const html = renderToStaticMarkup(
		createElement(SessionPanel, {
			summary: sessionSummary({ ...base, project: undefined, servers: { state: 'hidden' } }),
			chatOnly: true,
			jobs: [],
			jobsKnown: true,
			now: 0,
			onClose: () => {},
			onOpenChanges: () => {},
			onOpenWork: () => {},
		}),
	)
	expect(html).toContain('aria-label="Environment"')
	expect(html.indexOf('aria-label="Environment"')).toBeLessThan(
		html.indexOf('aria-label="Context"'),
	)
	expect(html).toContain('This computer')
	expect(html).toContain('aria-label="Background tasks"')
	expect(html).not.toContain('aria-label="Changes"')
	expect(html).not.toContain('Remote')
})

it('names a chat’s own folder in plain words, with a shortened path and no branch', () => {
	const path = '/home/someone/.namzu/chats/a-very-long-folder-name-that-goes-on-and-on-and-on'
	const summary = sessionSummary({
		...base,
		project: { name: 'chats', path, trusted: true, kind: 'chat' },
		git: { projectId: 'p', branch: 'main', subject: 'x' } as never,
		servers: { state: 'hidden' },
	})
	expect(summary.environment.folder).toEqual({ name: 'Chat folder', path })
	expect(summary.environment.branch).toBeUndefined()
	expect(summary.environment.branchNote).toBeUndefined()
	const html = renderToStaticMarkup(
		createElement(SessionPanel, {
			summary,
			chatOnly: true,
			jobs: [],
			jobsKnown: true,
			now: 0,
			onClose: () => {},
			onOpenChanges: () => {},
			onOpenWork: () => {},
		}),
	)
	expect(html).toContain('Chat folder')
	expect(html).toContain('~/.namzu/chats/')
	expect(html).toContain('…')
	expect(html).toContain(path)
	expect(html).not.toContain('session-branch')
})
