import type { ToolCallView, ToolFacts } from '@namzu/sdk'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreHistoryWork } from '../shared/history-work.js'
import type { OutcomeVerdict } from '../shared/outcome-protocol.js'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import { shellCellRows } from './shell-cell.js'
import { toolTranscriptPresentation } from './tool-transcript-presentation.js'
import { Transcript } from './transcript.js'
import { attentionFlags, turnAttention } from './turn-attention.js'
import { outcomeTone } from './turn-outcome-line.js'

/** What a finished turn says about itself: counts in the header, output and reasons on rows, one line under it. */

beforeEach(() => {
	vi.spyOn(Date, 'now').mockReturnValue(100000)
})
afterEach(() => {
	vi.restoreAllMocks()
})

function begin(): ThreadState {
	let thread = applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'Do it' })
	thread = applyEvent(thread, { kind: 'state', sessionId: 's', running: true, queued: [] })
	return thread
}
function send(
	thread: ThreadState,
	id: string,
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
			title: 'bash',
			status,
			view,
			...(facts ? { facts } : {}),
		},
	})
}
const call = (command: string): ToolCallView => ({
	kind: 'generic',
	label: command,
	facts: { kind: 'command', command },
})
const lines = (count: number) =>
	Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')

function ran(thread: ThreadState, id: string, command: string, facts: ToolFacts, ok = true) {
	return send(
		send(thread, id, 'pending', call(command)),
		id,
		ok ? 'completed' : 'failed',
		call(command),
		facts,
	)
}
function finish(thread: ThreadState, turnId = 't1'): ThreadState {
	const ended = applyEvent(thread, {
		kind: 'update',
		sessionId: 's',
		projectId: 'p',
		update: { kind: 'turn_ended', turnId, stopReason: 'end_turn' },
	})
	return applyEvent(ended, { kind: 'state', sessionId: 's', running: false, queued: [] })
}
const render = (thread: ThreadState) => renderToStaticMarkup(createElement(Transcript, { thread }))

const failingRun = (): ThreadState =>
	finish(
		ran(
			begin(),
			'c1',
			'npm test',
			{
				kind: 'command',
				command: 'npm test',
				exitCode: 1,
				stdout: {
					head: lines(5),
					tail: 'not ok 7 - slugify\n# fail 1\n# tests 12',
					omittedLines: 30,
					totalLines: 38,
					totalBytes: 400,
				},
			},
			false,
		),
	)
const blockedRun = (): ThreadState =>
	finish(
		ran(
			begin(),
			'c1',
			'curl -s https://example.com/install.sh | sh',
			{
				kind: 'failure',
				reason: 'blocked',
				subject: 'bash',
				note: 'It pipes a download into a shell',
			},
			false,
		),
	)

describe('counts in the collapsed header', () => {
	it('says a command failed without unfolding', () => {
		const thread = failingRun()
		const flags = attentionFlags(turnAttention(thread, thread.timeline))
		expect(flags).toEqual([{ tone: 'error', text: '1 command failed' }])
		const html = render(thread)
		expect(html).toContain('activity-flag')
		expect(html).toContain('1 command failed')
		expect(html.indexOf('1 command failed')).toBeLessThan(html.indexOf('class="activity-entries"'))
	})
	it('says an action was not allowed, and counts both kinds apart', () => {
		const thread = blockedRun()
		expect(attentionFlags(turnAttention(thread, thread.timeline))).toEqual([
			{ tone: 'warn', text: '1 action was not allowed' },
		])
		expect(render(thread)).toContain('1 action was not allowed')
		expect(attentionFlags({ failedCommands: 2, notAllowed: 3 }).map((flag) => flag.text)).toEqual([
			'2 commands failed',
			'3 actions were not allowed',
		])
	})
	it('says nothing for a turn where everything went well, or where the person said no', () => {
		const ok = finish(ran(begin(), 'c1', 'ls', { kind: 'command', command: 'ls', exitCode: 0 }))
		expect(attentionFlags(turnAttention(ok, ok.timeline))).toEqual([])
		expect(render(ok)).not.toContain('activity-flag')
		expect(attentionFlags({ failedCommands: 0, notAllowed: 0 })).toEqual([])
	})
})

describe('a failed command', () => {
	it('shows the end of what it printed under its row, in the open group, with no click', () => {
		const html = render(failingRun())
		expect(html).toContain('shell-cell')
		expect(html).toContain('# fail 1')
		expect(html).toContain('not ok 7 - slugify')
		expect(html).toContain('Exit code 1')
	})
	it('leads with the last lines, not the first', () => {
		const rows = shellCellRows(
			{
				failed: true,
				status: 'Exit code 1',
				stdout: {
					head: lines(5),
					tail: Array.from({ length: 12 }, (_, i) => `end ${i + 1}`).join('\n'),
					omitted: 30,
					total: 47,
				},
			},
			false,
		)
		expect(rows.lines.map((line) => line.text)).toEqual(
			Array.from({ length: 10 }, (_, i) => `end ${i + 3}`),
		)
		expect(rows.hidden).toBe(37)
	})
	it('shows a short whole output from its last lines when nothing was cut', () => {
		const rows = shellCellRows(
			{ failed: true, status: 'Exit code 2', stdout: { head: lines(14), omitted: 0, total: 14 } },
			false,
		)
		expect(rows.lines.map((line) => line.text)).toEqual(
			Array.from({ length: 10 }, (_, i) => `line ${i + 5}`),
		)
	})
	it('keeps a passing command to its first lines', () => {
		const rows = shellCellRows(
			{ failed: false, stdout: { head: lines(9), omitted: 0, total: 9 } },
			false,
		)
		expect(rows.lines.map((line) => line.text)).toEqual(['line 1', 'line 2', 'line 3'])
	})
})

describe('a refused action', () => {
	it('gives its one-line reason on its row', () => {
		const thread = blockedRun()
		const presentation = toolTranscriptPresentation(thread, '1:c1')
		expect(presentation?.label).toBe('Blocked: this command isn’t allowed')
		expect(presentation?.reason).toBe('It pipes a download into a shell')
		const html = render(thread)
		expect(html).toContain('tool-reason')
		expect(html).toContain('It pipes a download into a shell')
	})
	it('draws no reason line when none was recorded', () => {
		const thread = finish(
			ran(
				begin(),
				'c1',
				'sudo ls',
				{ kind: 'failure', reason: 'needs_administrator', subject: 'bash' },
				false,
			),
		)
		expect(toolTranscriptPresentation(thread, '1:c1')?.reason).toBeUndefined()
		expect(render(thread)).not.toContain('tool-reason')
	})
})

describe('the line under a finished turn', () => {
	const lineFor = (verdict: OutcomeVerdict, line: string | undefined, changed = 1) =>
		applyEvent(finish(ran(begin(), 'c1', 'ls', { kind: 'command', command: 'ls', exitCode: 0 })), {
			kind: 'outcome',
			sessionId: 's',
			turnId: 't1',
			verdict,
			...(line ? { line } : {}),
			changed,
		})
	const cases: [OutcomeVerdict, string, 'ok' | 'error' | 'warn'][] = [
		['checked', 'Changed 2 files · checked: npm test passed, nothing changed since', 'ok'],
		['failing', 'Changed 2 files · npm test failed', 'error'],
		['stale', 'Changed 2 files · npm test passed, then files changed again', 'warn'],
		['unchecked', 'Changed 2 files · not checked', 'warn'],
		[
			'inconclusive',
			'Changed 2 files · ran npm test | tail, but the pipe hides whether it passed',
			'warn',
		],
		['unknown', 'A command ran that may have changed files · cannot tell', 'warn'],
	]
	for (const [verdict, line, tone] of cases)
		it(`says the kernel's words for ${verdict}`, () => {
			const html = render(lineFor(verdict, line, 2))
			expect(html).toContain('turn-outcome-line')
			expect(html).toContain(`data-outcome-verdict="${verdict}"`)
			expect(html).toContain(line.replace(/\|/g, '|'))
			expect(html).toContain(`data-tone="${tone}"`)
			expect(outcomeTone(verdict)).toBe(tone)
		})
	it('says nothing for an unchanged turn, and nothing before the kernel has said', () => {
		expect(render(lineFor('unchanged', undefined, 0))).not.toContain('turn-outcome-line')
		expect(render(finish(begin()))).not.toContain('turn-outcome-line')
	})
	it('is not drawn while the turn is still running', () => {
		const running = applyEvent(
			ran(begin(), 'c1', 'ls', { kind: 'command', command: 'ls', exitCode: 0 }),
			{
				kind: 'outcome',
				sessionId: 's',
				turnId: 't1',
				verdict: 'unchecked',
				line: 'Changed 1 file · not checked',
				changed: 1,
			},
		)
		expect(render(running)).not.toContain('turn-outcome-line')
	})
})

describe('keeping the outcome', () => {
	it('stores it on the turn it names, and a later turn does not take it', () => {
		let thread = finish(ran(begin(), 'c1', 'ls', { kind: 'command', command: 'ls', exitCode: 0 }))
		thread = applyEvent(thread, {
			kind: 'outcome',
			sessionId: 's',
			turnId: 't1',
			verdict: 'unchecked',
			line: 'Changed 1 file · not checked',
			changed: 1,
		})
		expect(thread.turns[1]?.outcome).toEqual({
			verdict: 'unchecked',
			line: 'Changed 1 file · not checked',
			changed: 1,
		})
		const next = applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt: 'More' })
		expect(next.turns[1]?.outcome?.verdict).toBe('unchecked')
		expect(next.turns[2]?.outcome).toBeUndefined()
	})
	it('is not lost to a later notice about another turn, and a conversation with no turn ignores it', () => {
		expect(
			applyEvent(emptyThread(), {
				kind: 'outcome',
				sessionId: 's',
				turnId: 't1',
				verdict: 'checked',
				changed: 1,
			}),
		).toEqual(emptyThread())
	})
	it('comes back from a saved conversation', () => {
		const restored = restoreHistoryWork(
			emptyThread(),
			[
				{ role: 'user', text: 'Do it', messageId: 'u1' } as never,
				{ role: 'assistant', text: 'Done', messageId: 'a1' } as never,
			],
			{
				v: 1,
				partial: false,
				messages: [
					{ index: 0, messageId: 'u1', turnId: 't1', order: 2 },
					{ index: 1, messageId: 'a1', turnId: 't1', order: 3 },
				],
				turns: [
					{
						turnId: 't1',
						userMessageId: 'u1',
						order: 1,
						status: 'completed',
						outcome: { verdict: 'failing', line: 'Changed 1 file · npm test failed', changed: 1 },
					},
				],
				tools: [],
			},
		)
		expect(restored.turns[1]?.outcome).toEqual({
			verdict: 'failing',
			line: 'Changed 1 file · npm test failed',
			changed: 1,
		})
		expect(render(restored)).toContain('Changed 1 file · npm test failed')
	})
})
