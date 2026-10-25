/**
 * Every row that tells the person "ctrl+o to expand" has something hidden, and
 * the detailed transcript shows it. One case per producer of that hint: each
 * row comes from the builder the live run and a resumed conversation share,
 * is drawn as the transcript draws it (the hint must show and the marker line
 * must not), and then as the screen draws it (the marker line shows and no hint
 * is left).
 */

import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import { Transcript } from '../Transcript.js'
import { TranscriptScreen } from '../TranscriptScreen.js'
import { childMessageRow } from '../agent-transcript-rows.js'
import {
	COMPACTED_HINT,
	COMPACTED_TEXT,
	COMPACT_RESULT_HINT,
	COMPACT_RESULT_TEXT,
	compactionHistoryLines,
	compactionSummaryLines,
} from '../compaction-rows.js'
import { conversationEvidenceView } from '../conversation-evidence-view.js'
import { diffBodyFromFacts } from '../diff-rows.js'
import { EMPTY_GROUP, foldOp, groupText } from '../read-search-group.js'
import { agentCompletionRows, numberDetailRows } from '../restored-rows.js'
import {
	type ToolEndEvent,
	type ToolEndStart,
	type ToolRow,
	toolEndRows,
} from '../tool-end-rows.js'
import { EXPAND_HINT } from '../truncation.js'
import type { TranscriptMessage } from '../types.js'

const HINT = /\(ctrl\+o [^)]*\)/

const lineNo = (n: number) => `hidden-body-line-${String(n).padStart(2, '0')}`
const body = (count: number) => Array.from({ length: count }, (_, i) => lineNo(i + 1))

function rowsOf(
	event: Partial<ToolEndEvent>,
	start?: ToolEndStart,
	hasPlan = false,
): readonly ToolRow[] {
	const built = toolEndRows(
		{
			kind: 'tool-end',
			toolUseId: 'c1',
			toolName: 'tool',
			isError: false,
			summary: 'did a thing',
			...event,
		} as ToolEndEvent,
		start,
		{ hasPlan },
	)
	if (built.kind !== 'rows') throw new Error('expected rows')
	return built.rows
}

function messages(rows: readonly ToolRow[]): readonly TranscriptMessage[] {
	return numberDetailRows(rows.map((row, i) => ({ id: `r${i}`, ...row })))
}

function live(rows: readonly TranscriptMessage[]): string {
	const view = render(
		<Transcript messages={rows} pending={null} state="idle" settled={0} resetKey={0} />,
	)
	const frame = view.lastFrame() ?? ''
	view.unmount()
	return frame
}

function screen(rows: readonly TranscriptMessage[]): string {
	const view = render(
		<TranscriptScreen
			messages={rows}
			pending={null}
			rows={400}
			columns={100}
			dialogWaiting={false}
			onClose={() => {}}
		/>,
	)
	const frame = view.lastFrame() ?? ''
	view.unmount()
	return frame
}

/** The hint shows on the live row, hides `hidden`, and the screen shows `hidden` with no hint. */
function expectTrueHint(rows: readonly TranscriptMessage[], hidden: string): void {
	const drawn = live(rows)
	expect(drawn, 'the hint should be on the row').toMatch(HINT)
	expect(drawn, 'the live row should not show the hidden part').not.toContain(hidden)
	const inScreen = screen(rows)
	expect(inScreen, 'the screen should show the hidden part').toContain(hidden)
	expect(inScreen, 'the screen points at itself').not.toMatch(HINT)
}

describe('a collapsed group of looks', () => {
	const read = { label: 'Read(a.ts)', fold: { kind: 'read', key: 'a.ts' } } as const

	it('a settled group shows every call and its result', () => {
		const rows = messages(rowsOf({ toolName: 'read', output: body(8).join('\n') }, read))
		expectTrueHint(rows, lineNo(8))
	})

	it('a group made only of a failed call shows the call and its error', () => {
		const rows = messages(
			rowsOf(
				{ toolName: 'read', isError: true, output: 'ENOENT: no such file or directory' },
				read,
			),
		)
		const drawn = live(rows)
		expect(drawn).toContain('Read 1 file (ctrl+o to expand)')
		expect(drawn).not.toContain('ENOENT')
		const inScreen = screen(rows)
		expect(inScreen).toContain('Read(a.ts)')
		expect(inScreen).toContain('Error: ENOENT: no such file or directory')
		expect(inScreen).not.toMatch(HINT)
	})

	it('an open group shows the calls that have finished', () => {
		const state = foldOp(EMPTY_GROUP, { kind: 'search', hint: '"needle"' }, 0)
		const open: TranscriptMessage = {
			id: 'g',
			role: 'tool',
			content: groupText(state, true),
			pending: true,
			glyph: ' ',
			activity: 'exploration',
			group: state,
			detail: ['Search(needle)', lineNo(1)],
		}
		expect(live([open])).toContain('(ctrl+o to expand)')
		expect(live([open])).not.toContain(lineNo(1))
		const inScreen = screen([open])
		expect(inScreen).toContain(lineNo(1))
		expect(inScreen).not.toMatch(HINT)
	})
})

describe('a failed call', () => {
	it('shows the tool error ten lines at a time and all of it in the screen', () => {
		const rows = messages(rowsOf({ isError: true, output: body(16).join('\n') }))
		const drawn = live(rows)
		expect(drawn).toMatch(/… \+\d+ lines? \(ctrl\+o to expand\)/)
		expect(drawn).not.toContain(lineNo(16))
		expect(screen(rows)).toContain(lineNo(16))
		expect(screen(rows)).not.toMatch(HINT)
	})

	it('a classified failure keeps the tool message behind the hint', () => {
		const rows = messages(
			rowsOf({
				isError: true,
				plainFailure: 'Couldn’t find that text.',
				output: `Error: ${lineNo(1)}\n${lineNo(2)}`,
			}),
		)
		expectTrueHint(rows, lineNo(2))
	})

	it('a failed agent call shows its whole error in the screen', () => {
		const rows = messages(rowsOf({ toolName: 'agent', isError: true, output: body(16).join('\n') }))
		expect(live(rows)).toMatch(HINT)
		expect(live(rows)).not.toContain(lineNo(16))
		expect(screen(rows)).toContain(lineNo(16))
		expect(screen(rows)).not.toMatch(HINT)
	})
})

describe('a long result', () => {
	it('a shell command folds its output and the screen shows all of it', () => {
		const rows = messages(
			rowsOf(
				{
					toolName: 'bash',
					shell: { stdout: body(30), stderr: [], failed: false },
				},
				{ label: 'Bash(seq 1 30)', command: 'seq 1 30' },
			),
		)
		expectTrueHint(rows, lineNo(15))
		expect(screen(rows)).toContain(lineNo(30))
	})

	it('a result body folds after six lines', () => {
		const rows = messages(rowsOf({ summary: 'ok', detail: body(20) }))
		expectTrueHint(rows, lineNo(10))
	})

	it('a very long line is shortened and the screen shows it whole', () => {
		const long = `start-${'x'.repeat(400)}-the-very-end`
		const rows = messages(rowsOf({ summary: 'ok', detail: [long, 'short'] }))
		expect(live(rows)).toMatch(/line shortened \(ctrl\+o to expand\)/)
		expect(live(rows).replace(/\s+/g, '')).not.toContain('the-very-end')
		const inScreen = screen(rows).replace(/\s+/g, '')
		expect(inScreen).toContain('the-very-end')
	})

	it('a created file folds after its first ten lines', () => {
		const content = Array.from(
			{ length: 16 },
			(_, i) => `file-line-${String(i + 1).padStart(2, '0')}`,
		)
		const diffBody = diffBodyFromFacts(
			{
				kind: 'write',
				path: '/work/notes.txt',
				operation: 'created',
				added: 16,
				hunks: [
					{
						oldStart: 0,
						oldLines: 0,
						newStart: 1,
						newLines: 16,
						lines: content.map((line) => `+${line}`),
					},
				],
			},
			'/work',
		)
		const rows = messages(
			rowsOf(
				{
					toolName: 'write',
					summary: 'Wrote 16 lines',
					detail: diffBody?.rows,
					diff: diffBody?.diff,
				},
				{ label: 'Write(notes.txt)' },
			),
		)
		expectTrueHint(rows, 'file-line-16')
	})

	it('a web fetch keeps its result behind the hint', () => {
		const rows = messages(
			rowsOf({
				toolName: 'web_fetch',
				web: { kind: 'fetch', target: 'https://example.com' },
				output: body(12).join('\n'),
			}),
		)
		expectTrueHint(rows, lineNo(12))
	})

	it('a conversation lookup keeps its receipt behind the hint', () => {
		const receipt = {
			turnId: 'bcd3d4e0-ea88-4cfa-afb1-ed135da49ea8',
			seq: 2,
			part: 0,
			source: 'tool_completed',
			recordKind: 'tool_result',
			toolName: 'read',
			text: 'Original receipt',
			offset: 0,
			complete: true,
			retainedPreview: false,
			lastField: 'receipt-final-field',
		}
		const output = JSON.stringify(receipt)
		expect(conversationEvidenceView('read_conversation', output)).toBeDefined()
		const rows = messages(rowsOf({ toolName: 'read_conversation', output }))
		expectTrueHint(rows, 'receipt-final-field')
	})
})

describe('a compaction', () => {
	it('an automatic one keeps its counts behind the hint', () => {
		const detail = compactionHistoryLines({
			messagesBefore: 40,
			messagesAfter: 6,
			tokensBefore: 90_000,
			tokensAfter: 12_000,
			measuredBy: 'provider',
		})
		const rows: TranscriptMessage[] = [
			{
				id: 'c',
				role: 'system',
				content: COMPACTED_TEXT,
				glyph: '✻',
				meta: COMPACTED_HINT,
				activity: 'summary',
				detail,
				detailRef: 1,
			},
		]
		const drawn = live(rows)
		expect(drawn).toContain('(ctrl+o for history)')
		expect(drawn).not.toContain('became')
		const inScreen = screen(rows)
		expect(inScreen).toContain('40 messages became 6 messages.')
		expect(inScreen).not.toMatch(HINT)
	})

	it('/compact keeps the summary behind the hint', () => {
		const rows: TranscriptMessage[] = [
			{
				id: 'c',
				role: 'system',
				content: COMPACT_RESULT_TEXT,
				glyph: '✻',
				meta: COMPACT_RESULT_HINT,
				activity: 'summary',
				detail: compactionSummaryLines('[COMPACTED CONTEXT]\n\nThe user asked for a-summary-line.'),
				detailRef: 1,
			},
		]
		expect(live(rows)).toContain('(ctrl+o to see full summary)')
		expect(live(rows)).not.toContain('a-summary-line')
		expect(screen(rows)).toContain('a-summary-line')
		expect(screen(rows)).not.toMatch(HINT)
	})
})

describe('delegated work', () => {
	const agent = (extra: Partial<SubagentActivity>): SubagentActivity =>
		({
			viewId: 'a',
			agentId: 'general-purpose',
			description: 'beta lookup',
			prompt: 'p',
			batchId: 'b',
			workflowId: 'w',
			workflowGroupId: '[]',
			phaseId: '[]',
			workflow: 'Delegated work',
			phase: 'Work',
			phaseSequence: 1,
			status: 'completed',
			startedAt: 1,
			completedAt: 8_001,
			background: true,
			transcript: [],
			...extra,
		}) as SubagentActivity

	it('a finished agent keeps its answer behind the hint', () => {
		const answer = {
			id: 'x:assistant',
			kind: 'assistant' as const,
			text: 'the-agents-final-answer',
		}
		const rows = messages(agentCompletionRows(agent({ transcript: [answer as never] })))
		expect(rows[0]?.meta).toBe(EXPAND_HINT)
		expectTrueHint(rows, 'the-agents-final-answer')
	})

	it('a message an agent sent keeps its text behind the hint', () => {
		const row = childMessageRow({ agentId: 'counter', text: 'first line\nthe-second-line' })
		const rows = messages([
			{
				role: 'tool',
				content: row.content,
				glyph: '›',
				detail: row.detail,
				meta: row.hint,
				activity: 'agent-result',
			},
		])
		expectTrueHint(rows, 'the-second-line')
	})
})
