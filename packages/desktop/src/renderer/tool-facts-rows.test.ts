import type { ToolCallView, ToolFacts } from '@namzu/sdk'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import { ActivityActionsContext } from './activity-actions.js'
import { ToolBodyView } from './tool-output-view.js'
import { toolTranscriptPresentation } from './tool-transcript-presentation.js'
import { ToolTranscriptRow } from './tool-transcript-row.js'
import { actionRunLabel } from './transcript-layout.js'
import { turnChanges } from './turn-changes.js'

/**
 * Rows built from typed facts. The tool results below carry the model's own prose in their view
 * ("STDOUT:", "replacement(s)", "Error: ...") and none of it may reach the person.
 */

function begin(): ThreadState {
	let thread = applyEvent(emptyThread(), {
		kind: 'prompt',
		sessionId: 's',
		prompt: 'Do it',
	})
	thread = applyEvent(thread, {
		kind: 'state',
		sessionId: 's',
		running: true,
		queued: [],
	})
	return thread
}

function send(
	thread: ThreadState,
	id: string,
	title: string,
	status: 'pending' | 'completed' | 'failed',
	view: ToolCallView,
	facts?: ToolFacts,
): ThreadState {
	return applyEvent(thread, {
		kind: 'update',
		sessionId: 's',
		projectId: 'p',
		update: {
			kind: 'tool_call',
			toolCallId: id,
			title,
			status,
			view,
			...(facts ? { facts } : {}),
		},
	})
}

function call(
	title: string,
	callView: ToolCallView,
	view: ToolCallView,
	facts: ToolFacts | undefined,
	status: 'completed' | 'failed' = 'completed',
	id = 'c',
): ThreadState {
	let thread = send(begin(), id, title, 'pending', callView)
	thread = send(thread, id, title, status, view, facts)
	return thread
}

const key = (id = 'c') => `1:${id}`
const row = (thread: ThreadState, id = 'c') => toolTranscriptPresentation(thread, key(id))

const bash = (command: string): ToolCallView => ({
	kind: 'generic',
	label: command,
	facts: { kind: 'command', command },
})
const modelText = (output: string): ToolCallView => ({
	kind: 'terminal',
	output,
})

describe('reads, searches and listings', () => {
	const read = (path: string): ToolCallView => ({
		kind: 'generic',
		label: `Read ${path}`,
		presentation: 'activity',
		activity: 'exploration',
		facts: { kind: 'read', path },
	})

	it('headline a read by its file and not by the numbered text', () => {
		const thread = call('read', read('a.ts'), modelText('     1\texport const a = 1'), {
			kind: 'read',
			path: '/p/a.ts',
			bytes: 19,
			totalLines: 1,
			returnedLines: 1,
		})
		expect(row(thread)).toMatchObject({
			label: 'Read a.ts',
			lead: 'Read',
			kind: 'read',
			file: { name: 'a.ts', path: '/p/a.ts' },
		})
		expect(row(thread)?.detailView).toBeUndefined()
	})

	it('reads a Turkish file name whole', () => {
		const thread = call('read', read('Çalışma-ğüş.md'), modelText('x'), {
			kind: 'read',
			path: '/p/Çalışma-ğüş.md',
		})
		expect(row(thread)?.label).toBe('Read Çalışma-ğüş.md')
	})

	it('says binary instead of drawing the bytes', () => {
		const thread = call('read', read('blob.bin'), modelText('1\t��'), {
			kind: 'read',
			path: '/p/blob.bin',
			binary: true,
			bytes: 4096,
		})
		expect(row(thread)).toMatchObject({
			label: 'Read blob.bin · Binary file, 4.1 KB',
			tail: ' · Binary file, 4.1 KB',
		})
		expect(row(thread)?.detailView).toBeUndefined()
	})

	it('counts three reads as three files with the read icon', () => {
		const actions = ['a.ts', 'b.ts', 'c.ts'].map((name) => ({
			kind: 'read' as const,
			subject: `/p/${name}`,
			state: 'completed' as const,
		}))
		expect(actionRunLabel(actions, false)).toBe('Read 3 files')
	})

	it('names a search by what it looked for, with the counts beside it', () => {
		const thread = call(
			'grep',
			{
				kind: 'generic',
				label: 'Search export in .',
				facts: { kind: 'search', pattern: 'export', path: '.' },
			},
			modelText('./a.ts:1:export const a=1\n\nFound 2 match(es) in 2 file(s) (3 files searched)'),
			{
				kind: 'search',
				pattern: 'export',
				path: '.',
				matches: 2,
				filesMatched: 2,
				filesSearched: 3,
			},
		)
		const found = row(thread)
		expect(found).toMatchObject({
			label: 'Searched for export · 2 matches in 2 files',
			main: 'Searched for export',
			kind: 'search',
		})
		expect(found?.label).not.toContain('match(es)')
		expect(found?.detailView).toBeUndefined()
	})

	it('pluralises one match and none', () => {
		const one = call(
			'grep',
			{ kind: 'generic', label: 'x', facts: { kind: 'search', pattern: 'x' } },
			modelText('x'),
			{ kind: 'search', pattern: 'x', matches: 1, filesMatched: 1 },
		)
		expect(row(one)?.label).toBe('Searched for x · 1 match in 1 file')
		const none = call(
			'grep',
			{ kind: 'generic', label: 'x', facts: { kind: 'search', pattern: 'x' } },
			modelText('x'),
			{ kind: 'search', pattern: 'x', matches: 0, filesMatched: 0 },
		)
		expect(row(none)?.label).toBe('Searched for x · no matches')
	})

	it('lists a pattern without a dot for the project folder, and names a subfolder', () => {
		const root = call(
			'glob',
			{
				kind: 'generic',
				label: 'Find **/*.ts in .',
				facts: { kind: 'list', pattern: '**/*.ts', path: '.' },
			},
			modelText('./a.ts'),
			{ kind: 'list', pattern: '**/*.ts', path: '.', count: 1 },
		)
		expect(row(root)).toMatchObject({
			label: 'Listed **/*.ts · 1 file',
			tooltip: 'Listed **/*.ts in this folder',
		})
		expect(row(root)?.label).not.toMatch(/ \. /)
		const nested = call(
			'glob',
			{
				kind: 'generic',
				label: 'x',
				facts: { kind: 'list', pattern: '*.ts', path: 'src' },
			},
			modelText('x'),
			{ kind: 'list', pattern: '*.ts', path: 'src', count: 4, truncated: true },
		)
		expect(row(nested)?.label).toBe('Listed *.ts in src · 4 files, more not shown')
	})

	it('keeps a failed search from becoming a bare dot', () => {
		const thread = call(
			'glob',
			{
				kind: 'generic',
				label: '.',
				facts: { kind: 'list', pattern: '**/*.ts', path: '.' },
			},
			modelText('Error: boom'),
			undefined,
			'failed',
		)
		expect(row(thread)?.label).toBe("Couldn't list **/*.ts")
	})
})

describe('edits and writes', () => {
	const editDiff: ToolCallView = {
		kind: 'diff',
		path: 'a.ts',
		before: 'export const a = 1\n',
		after: 'export const a = 2\n',
	}

	it('headlines a finished edit as an edit with its lines, never the receipt sentence', () => {
		const thread = call(
			'edit',
			editDiff,
			{ kind: 'generic', label: 'Edited /tmp/proj/a.ts: 1 replacement(s)' },
			{ kind: 'edit', path: '/tmp/proj/a.ts', replacements: 1 },
		)
		const edited = row(thread)
		expect(edited).toMatchObject({
			label: 'Edited a.ts',
			lead: 'Edited',
			kind: 'edit',
			file: { name: 'a.ts' },
			stats: { added: 1, removed: 1 },
		})
		expect(JSON.stringify(edited)).not.toContain('replacement(s)')
		expect(JSON.stringify(edited)).not.toContain('/tmp/proj')
	})

	it('turns the finished edit into a receipt the Changes card counts', () => {
		let thread = call(
			'edit',
			editDiff,
			{ kind: 'generic', label: 'Edited /tmp/proj/a.ts: 1 replacement(s)' },
			{ kind: 'edit', path: '/tmp/proj/a.ts', replacements: 1 },
			'completed',
			'e',
		)
		thread = send(thread, 'w', 'write', 'pending', {
			kind: 'generic',
			label: 'n.txt',
		})
		thread = send(
			thread,
			'w',
			'write',
			'completed',
			{ kind: 'diff', path: 'n.txt', before: '', after: 'one\n' },
			{
				kind: 'write',
				path: '/tmp/proj/n.txt',
				operation: 'created',
				bytes: 4,
			},
		)
		const changes = turnChanges(thread).get(1)
		expect(changes?.files.map((file) => [file.name, file.created])).toEqual([
			['a.ts', false],
			['n.txt', true],
		])
		expect(changes?.verb).toBe('Changed')
		expect(changes?.added).toBe(2)
	})

	it('says Created for a new file and Updated for a replaced one', () => {
		const created = call(
			'write',
			{ kind: 'generic', label: 'n.txt' },
			{ kind: 'diff', path: 'n.txt', before: '', after: 'one\n' },
			{
				kind: 'write',
				path: '/p/n.txt',
				operation: 'created',
				bytes: 4,
				added: 1,
				removed: 0,
			},
		)
		expect(row(created)).toMatchObject({
			label: 'Created n.txt',
			operation: 'created',
		})
		const updated = call(
			'write',
			{ kind: 'generic', label: 'n.txt' },
			{ kind: 'diff', path: 'n.txt', before: 'one\n', after: 'two\nthree\n' },
			{
				kind: 'write',
				path: '/p/n.txt',
				operation: 'updated',
				bytes: 10,
				added: 2,
				removed: 1,
			},
		)
		expect(row(updated)).toMatchObject({
			label: 'Updated n.txt',
			stats: { added: 2, removed: 1 },
		})
	})

	it('names an edit restored without its diff by the file the tool reported', () => {
		const thread = call(
			'edit',
			{ kind: 'generic', label: 'a.ts' },
			{ kind: 'generic', label: 'Edited /p/a.ts: 1 replacement(s)' },
			{ kind: 'edit', path: '/p/a.ts', replacements: 1 },
		)
		expect(row(thread)).toMatchObject({
			label: 'Edited a.ts',
			file: { path: '/p/a.ts' },
		})
	})
})

describe('commands', () => {
	const done = (command: string, facts: ToolFacts, status: 'completed' | 'failed' = 'completed') =>
		call('bash', bash(command), modelText('STDOUT:\nignored'), facts, status)

	it('leads with a short human headline and keeps the whole command for the tooltip', () => {
		const long = `echo ${'a'.repeat(100)}\nsecond line`
		const thread = done(long, { kind: 'command', command: long, exitCode: 0 })
		expect(row(thread)?.label).toBe(`Ran echo ${'a'.repeat(54)}…`)
		expect(row(thread)?.tooltip).toBe(long)
	})

	it('says Running while the command is live', () => {
		const thread = send(begin(), 'c', 'bash', 'pending', bash('sleep 75; echo ok'))
		expect(row(thread)).toMatchObject({
			label: 'Running sleep 75; echo ok',
			kind: 'command',
			state: 'running',
		})
	})

	it('says it failed and with what exit code', () => {
		const thread = done(
			'echo oops >&2; ls /nonexistent; exit 3',
			{
				kind: 'command',
				command: 'echo oops >&2; ls /nonexistent; exit 3',
				exitCode: 3,
				stderr: {
					head: 'oops\nls: cannot access',
					totalLines: 2,
					totalBytes: 24,
				},
			},
			'failed',
		)
		const failed = row(thread)
		expect(failed).toMatchObject({
			label: 'Ran echo oops >&2; ls /nonexistent; exit 3 · failed (exit 3)',
			tail: ' · failed (exit 3)',
			state: 'failed',
		})
		expect(failed?.body).toMatchObject({
			kind: 'streams',
			stderr: { head: 'oops\nls: cannot access' },
		})
	})

	it('names a timeout and a command that was stopped', () => {
		expect(
			row(done('sleep 999', { kind: 'command', command: 'sleep 999', timedOut: true }, 'failed'))
				?.tail,
		).toBe(' · timed out')
		expect(
			row(done('x', { kind: 'command', command: 'x', signal: 'SIGKILL' }, 'failed'))?.tail,
		).toBe(' · stopped')
	})

	it('never dumps binary output, only its size', () => {
		const thread = done('head -c 3000 /dev/urandom', {
			kind: 'command',
			command: 'head -c 3000 /dev/urandom',
			exitCode: 0,
			binary: { bytes: 3000 },
		})
		expect(row(thread)?.body).toEqual({
			kind: 'notice',
			text: 'Binary output, 3 KB',
		})
	})

	it('has nothing to open for a command that printed nothing', () => {
		const thread = done('true', {
			kind: 'command',
			command: 'true',
			exitCode: 0,
		})
		expect(row(thread)?.body).toBeUndefined()
		expect(row(thread)?.detailView).toBeUndefined()
	})

	it('carries both streams and the whole command when the headline had to cut it', () => {
		const command = `printf '${'x'.repeat(80)}'`
		const thread = done(command, {
			kind: 'command',
			command,
			exitCode: 0,
			stdout: { head: 'a', totalLines: 1, totalBytes: 1 },
			stderr: { head: 'b', totalLines: 1, totalBytes: 1 },
		})
		expect(row(thread)?.body).toMatchObject({
			kind: 'streams',
			command,
			stdout: { head: 'a' },
			stderr: { head: 'b' },
		})
	})

	it('still words a command from an engine that reports only a terminal view', () => {
		const thread = call(
			'bash',
			{ kind: 'terminal', command: 'ls', output: '' },
			{ kind: 'terminal', command: 'ls', output: 'a.txt' },
			undefined,
		)
		expect(row(thread)).toMatchObject({
			label: 'Ran ls',
			detailView: { kind: 'terminal' },
		})
	})
})

describe('failures', () => {
	const failed = (title: string, callView: ToolCallView, facts: ToolFacts, id = 'c'): ThreadState =>
		call(title, callView, modelText('Error: raw text the person must not see'), facts, 'failed', id)

	it('reads a missing file plainly', () => {
		const thread = failed(
			'read',
			{
				kind: 'generic',
				label: 'Read missing.txt',
				facts: { kind: 'read', path: 'nope/missing.txt' },
			},
			{
				kind: 'failure',
				reason: 'not_found',
				subject: '/tmp/proj/nope/missing.txt',
			},
		)
		expect(row(thread)).toMatchObject({
			label: "Couldn't read missing.txt: file not found",
			lead: "Couldn't read",
			file: { name: 'missing.txt', path: '/tmp/proj/nope/missing.txt' },
			state: 'failed',
		})
		expect(JSON.stringify(row(thread))).not.toContain('ENOENT')
		expect(row(thread)?.detailView).toBeUndefined()
	})

	it('says Namzu tried a tool it does not have', () => {
		const thread = failed(
			'ls',
			{ kind: 'generic', label: 'ls' },
			{ kind: 'failure', reason: 'unknown_tool', subject: 'ls' },
		)
		expect(row(thread)?.label).toBe("Namzu tried a tool it doesn't have (ls)")
	})

	it('says a command needing administrator rights was blocked, and why', () => {
		const thread = failed('bash', bash('sudo rm -rf /var/x'), {
			kind: 'failure',
			reason: 'needs_administrator',
			subject: 'bash',
		})
		expect(row(thread)).toMatchObject({
			label: 'Blocked: this command needs administrator rights',
			kind: 'command',
			tooltip: 'sudo rm -rf /var/x',
		})
	})

	it('says any other refusal was a block', () => {
		const thread = failed('bash', bash('rm -r x'), {
			kind: 'failure',
			reason: 'blocked',
			subject: 'bash',
		})
		expect(row(thread)?.label).toBe("Blocked: this command isn't allowed")
	})

	it('explains a write that would have replaced a file nobody read', () => {
		const thread = failed(
			'write',
			{ kind: 'generic', label: 'out.txt' },
			{ kind: 'failure', reason: 'already_exists', subject: '/p/out.txt' },
		)
		expect(row(thread)?.label).toBe("Couldn't change out.txt: it already exists")
	})
})

describe('what the row opens to', () => {
	it('draws stdout alone without a label and stderr under a quiet one when both exist', () => {
		const both = renderToStaticMarkup(
			createElement(ToolBodyView, {
				body: {
					kind: 'streams',
					stdout: { head: 'hello', omitted: 0, total: 1 },
					stderr: { head: 'oops', omitted: 0, total: 1 },
				},
			}),
		)
		expect(both).toContain('Errors')
		expect(both).toContain('hello')
		expect(both).toContain('oops')
		expect(both).not.toContain('STDOUT')
		expect(both).not.toContain('STDERR')
		const only = renderToStaticMarkup(
			createElement(ToolBodyView, {
				body: {
					kind: 'streams',
					stderr: { head: 'oops', omitted: 0, total: 1 },
				},
			}),
		)
		expect(only).not.toContain('Errors')
	})

	it('renders colour as classes on text, never as markup', () => {
		const html = renderToStaticMarkup(
			createElement(ToolBodyView, {
				body: {
					kind: 'streams',
					stdout: {
						head: '\u001b[31mred\u001b[0m \u001b[1;32mgreen\u001b[0m <b>und</b>',
						omitted: 0,
						total: 1,
					},
				},
			}),
		)
		expect(html).toContain('class="ansi-red"')
		expect(html).toContain('red')
		expect(html).not.toContain('\u001b')
		expect(html).toContain('&lt;b&gt;und&lt;/b&gt;')
		expect(html).not.toContain('<b>')
	})

	it('folds a long output to its head and tail with Show more', () => {
		const lines = Array.from({ length: 600 }, (_, i) => String(i + 1))
		const html = renderToStaticMarkup(
			createElement(ToolBodyView, {
				body: {
					kind: 'streams',
					stdout: {
						head: lines.slice(0, 80).join('\n'),
						tail: lines.slice(-40).join('\n'),
						omitted: 480,
						total: 600,
					},
				},
			}),
		)
		expect(html).toContain('Show more')
		expect(html).toContain('>1\n2\n3')
		expect(html).toContain('600')
		expect(html).toContain('588 lines not shown')
		expect(html).not.toContain('retained')
		expect(html).not.toContain('host-authorized')
		expect(html).not.toContain('\n20\n')
	})

	it('shows the notice for binary output and nothing else', () => {
		const html = renderToStaticMarkup(
			createElement(ToolBodyView, {
				body: { kind: 'notice', text: 'Binary output, 3 KB' },
			}),
		)
		expect(html).toContain('Binary output, 3 KB')
	})
})

describe('the rendered row', () => {
	it('draws the headline, the failure beside it, and no model prose', () => {
		const thread = call(
			'bash',
			bash('exit 3'),
			modelText(
				'STDERR:\noops\n\nNOTE: 1 credential-shaped environment variable(s) were withheld\n\nError: Command exited with code 3',
			),
			{
				kind: 'command',
				command: 'exit 3',
				exitCode: 3,
				stderr: { head: 'oops', totalLines: 1, totalBytes: 5 },
			},
			'failed',
		)
		const html = renderToStaticMarkup(createElement(ToolTranscriptRow, { thread, id: key() }))
		expect(html).toContain('Ran exit 3')
		expect(html).toContain('failed (exit 3)')
		// The failure is said once, beside the headline: the separate badge is for screen readers only.
		expect(html).toMatch(/class="tool-status transcript-visually-hidden">Failed</)
		expect(html).not.toMatch(/class="tool-status">Failed</)
		for (const hidden of ['STDERR', 'NOTE:', 'withheld', 'Error:', 'credential']) {
			expect(html).not.toContain(hidden)
		}
	})

	it('draws an edit with its lines and a created file as created', () => {
		const thread = call(
			'edit',
			{ kind: 'diff', path: 'a.ts', before: 'a\n', after: 'b\nc\n' },
			{ kind: 'generic', label: 'Edited /p/a.ts: 1 replacement(s)' },
			{ kind: 'edit', path: '/p/a.ts', replacements: 1 },
		)
		const html = renderToStaticMarkup(createElement(ToolTranscriptRow, { thread, id: key() }))
		expect(html).toContain('Edited')
		expect(html).toContain('a.ts')
		expect(html).toContain('+2')
		expect(html).toContain('−1')
		expect(html).not.toContain('replacement')
	})
})

describe('opening a file from its row', () => {
	const open = (thread: ThreadState) =>
		renderToStaticMarkup(
			createElement(
				ActivityActionsContext.Provider,
				{ value: { onOpenChangedFile: () => {} } },
				createElement(ToolTranscriptRow, { thread, id: key() }),
			),
		)

	it('opens a file that was read', () => {
		const thread = call(
			'read',
			{ kind: 'generic', label: 'Read a.ts', facts: { kind: 'read', path: 'a.ts' } },
			modelText('x'),
			{ kind: 'read', path: '/p/a.ts' },
		)
		expect(open(thread)).toContain('tool-open')
	})

	it('does not offer to open a file that was not found', () => {
		const thread = call(
			'read',
			{ kind: 'generic', label: 'Read missing.txt', facts: { kind: 'read', path: 'missing.txt' } },
			modelText('Error: ENOENT'),
			{ kind: 'failure', reason: 'not_found', subject: '/p/missing.txt' },
			'failed',
		)
		expect(open(thread)).not.toContain('tool-open')
		expect(open(thread)).toContain('file not found')
	})
})
