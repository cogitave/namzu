import { describe, expect, it } from 'vitest'

import { type ToolEndEvent, toolEndRows } from '../tool-end-rows.js'

const SCRIPT_FAILURE = [
	"The script stopped at line 3, column 20: cannot read property 'length' of undefined",
	'That line reads: const x = args.nope.length',
	'No agent had started. Last phase: "A".',
	'This call passed no "args", so `args` was undefined in the script.',
].join('\n')

function failed(output: string): ToolEndEvent {
	return {
		kind: 'tool-end',
		toolUseId: 't1',
		toolName: 'workflow',
		isError: true,
		summary: output.split('\n')[0] ?? '',
		output,
	} as ToolEndEvent
}

describe('a workflow script that could not run', () => {
	const built = toolEndRows(
		failed(SCRIPT_FAILURE),
		{ label: 'Workflow(Broken)' },
		{ hasPlan: false },
	)
	if (built.kind !== 'rows') throw new Error('expected rows')
	const result = built.rows[1]

	it('says one plain sentence, with no failure prefix or error name', () => {
		expect(result?.content).toBe(
			"The script stopped at line 3, column 20: cannot read property 'length' of undefined.",
		)
		expect(result?.content).not.toMatch(/Error:|failed:/)
	})

	it('keeps the line, the phase and the hint for the model behind ctrl+o', () => {
		expect(result?.detail).toEqual([
			'That line reads: const x = args.nope.length',
			'No agent had started. Last phase: "A".',
			'This call passed no "args", so `args` was undefined in the script.',
		])
		expect(result?.activity).toBe('evidence')
		expect(result?.meta).toBe('(ctrl+o to expand)')
	})

	it('drops an error name the interpreter put in front', () => {
		const rows = toolEndRows(
			failed('TypeError: Error: boom'),
			{ label: 'Workflow(x)' },
			{ hasPlan: false },
		)
		if (rows.kind !== 'rows') throw new Error('expected rows')
		expect(rows.rows[1]?.content).toBe('boom.')
		expect(rows.rows[1]?.detail).toBeUndefined()
	})
})
