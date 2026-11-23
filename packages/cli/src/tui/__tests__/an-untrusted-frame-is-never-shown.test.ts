/**
 * The frame a delegated answer or a fetched page arrives in is for the model.
 * A row shows the words inside it, for every tool, live and restored (the
 * restored rows are built by the same function), and the model's own copy is
 * left as it was.
 */
import { type SessionEvent, wrapUntrusted } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { builtinToolPresenter, toAgentEvent } from '../agent.js'
import { withoutUntrustedFrames } from '../untrusted-display.js'

const env = { sessionId: 's', turnId: 't' }
const frame = (text: string) =>
	wrapUntrusted(
		{ kind: 'agent-result', attributes: { agent: 'a', task: 't1' }, provenance: 'From an agent.' },
		text,
	)

function shownOf(toolName: string, result: string): string {
	const end = toAgentEvent(
		{
			type: 'tool_completed',
			toolUseId: 'u1',
			toolName,
			result,
			isError: false,
			...env,
		} as unknown as SessionEvent,
		builtinToolPresenter(),
	)
	if (end?.kind !== 'tool-end') throw new Error('expected a tool end')
	return [end.summary, ...(end.detail ?? [])].join('\n')
}

describe('a framed result in a row', () => {
	it('is read past for a tool that is not a connector, text around the frame included', () => {
		const result = `task_id: t1\nstatus: completed\n\nAgent result:\n${frame('first line\n\nsecond line')}\n\nRecord of this run: ok`
		const shown = shownOf('some_other_tool', result)
		expect(shown).not.toContain('namzu-untrusted')
		expect(shown).toContain('first line')
		expect(shown).toContain('second line')
		// A work-status tool says how it came out in one line, with no frame in it.
		expect(shownOf('wait_for_task', result)).toBe('Finished')
	})

	it('is read past inside a JSON string, and for several frames', () => {
		const json = JSON.stringify({ agents: [{ output: frame('one') }, { output: frame('two') }] })
		const shown = shownOf('some_other_tool', json)
		expect(shown).not.toContain('namzu-untrusted')
		expect(shownOf('agent_task_list', json)).toBe('2 saved agents')
		expect(shown).toContain('one')
		expect(shown).toContain('two')
		const text = withoutUntrustedFrames(`${frame('a')}\nmiddle\n${frame('b')}`)
		expect(text).toBe('a\nmiddle\nb')
	})

	it('leaves text without a frame, and an opening with no end, untouched', () => {
		expect(withoutUntrustedFrames('plain text')).toBe('plain text')
		const open = '<namzu-untrusted-abc123 kind="x">\nhead\n\nbody'
		expect(withoutUntrustedFrames(open)).toBe(open)
	})
})
