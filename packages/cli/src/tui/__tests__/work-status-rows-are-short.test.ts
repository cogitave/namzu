/**
 * The rows for work-status tools are one plain line, from the same function
 * live and after a resume. The model's own copy of every result is verbatim.
 */
import type { Message, SessionEvent, ToolCall } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { builtinToolPresenter, toAgentEvent } from '../agent.js'
import { noticeDisplay } from '../notice-display.js'
import { restoredToolRows } from '../restored-rows.js'
import { toolEndRows } from '../tool-end-rows.js'

const LISTING = JSON.stringify({
	tasks: [],
	total: 0,
	omitted: 0,
	workflows: [],
	omittedWorkflows: 0,
})
const LOADED =
	'Activated 1 tool(s):\n- agent_task_list: Read the current status of this conversation work without\n  waiting or starting anything.'

const CASES: ReadonlyArray<{
	tool: string
	input: unknown
	output: string
	call: string
	result: string
}> = [
	{
		tool: 'agent_task_list',
		input: { run_id: 'w3wivgp4f' },
		output: LISTING,
		call: 'Checking agents',
		result: 'Nothing running',
	},
	{
		tool: 'search_tools',
		input: { query: 'select:agent_task_list' },
		output: LOADED,
		call: 'Loading tools',
		result: 'Loaded tools: agent_task_list',
	},
]

function liveRows(tool: string, input: unknown, output: string) {
	const presenter = builtinToolPresenter()
	const env = { sessionId: 's', turnId: 't', toolUseId: 'u1', toolName: tool }
	const started = toAgentEvent(
		{ type: 'tool_executing', input, ...env } as unknown as SessionEvent,
		presenter,
	)
	const ended = toAgentEvent(
		{ type: 'tool_completed', result: output, isError: false, ...env } as unknown as SessionEvent,
		presenter,
	)
	if (started?.kind !== 'tool-start' || ended?.kind !== 'tool-end') throw new Error('no events')
	const built = toolEndRows(ended, { label: started.summary }, { hasPlan: true })
	return { started, ended, rows: built.kind === 'rows' ? built.rows : [] }
}

describe('work-status rows', () => {
	for (const c of CASES) {
		it(`${c.tool} reads one short line live`, () => {
			const { ended, rows } = liveRows(c.tool, c.input, c.output)
			expect(ended.summary).toBe(c.result)
			expect(ended.detail ?? []).toEqual([])
			expect(ended.output).toBe(c.output)
			expect(rows.map((r) => r.content).join('\n')).not.toMatch(/\{|Activated|namzu-/)
		})

		it(`${c.tool} reads the same line after a resume`, () => {
			const call: ToolCall = {
				id: 'u1',
				type: 'function',
				function: { name: c.tool, arguments: JSON.stringify(c.input) },
			}
			const results = new Map<string, Message>([
				['u1', { role: 'tool', toolCallId: 'u1', content: c.output } as unknown as Message],
			])
			const rows = restoredToolRows(
				't',
				call,
				results,
				{ calls: new Map(), turns: new Map(), turnOfMessage: new Map() },
				builtinToolPresenter(),
			)
			expect(rows.map((r) => r.content)).toEqual([c.call, c.result])
		})
	}
})

describe('an injected notice', () => {
	const untrusted =
		'<namzu-untrusted-c894aa kind="workflow-result">\nFrom a workflow.\nEnds at </namzu-untrusted-c894aa>.\n\nthe result\n</namzu-untrusted-c894aa>'
	it('reads as the workflow line the live view writes', () => {
		const text = `Workflow "research-workflow-learning" (whpfigkan) completed.\nended_at: 2026-11-23T09:13:33.095Z\n<usage>agents: 2, agents_cached: 0, done: 2, failed: 0, skipped: 0, tokens: 127473, tool_calls: 1, duration: 1m 1s</usage>\n${untrusted}`
		const shown = noticeDisplay(text)
		expect(shown.label).toBe(
			'Workflow research-workflow-learning finished · 1m 1s · 2 agents · 127.5k tokens',
		)
		expect(shown.detail).toEqual([])
	})

	it('reads a framed background command exit as one line, without the frame or preamble', () => {
		const text =
			'<namzu-notice-532ecead kind="job">\n[Background job update]\nNamzu sent this automatically. The operator did not write it, so it is neither an answer to a question you asked nor an approval.\nThis block ends only at `</namzu-notice-532ecead>`.\nBackground job j1 (make test) exited with code 2 at 2026-11-23T09:00:00.000Z. Read its output with the job tool if you need it.\n</namzu-notice-532ecead>'
		const shown = noticeDisplay(text)
		expect(shown.label).toBe('Background command "make test" failed with exit code 2')
		expect(shown.detail).toEqual([])
	})
})
