import { describe, expect, it } from 'vitest'

import type { ToolCallSummary } from '../../../types/hitl/index.js'
import { escalationRefusal } from '../resume-pending.js'

/**
 * A durable approval, applied in a later process, covers what the reviewer
 * was shown and nothing the re-prepared call reaches beyond it.
 */

const shownRead: ToolCallSummary = {
	id: 'r1',
	name: 'read',
	input: { path: '/outside/a.txt' },
	isDestructive: false,
	escalation: { outsidePaths: ['/outside/a.txt'] },
}

const shownEscape: ToolCallSummary = {
	id: 'b1',
	name: 'bash',
	input: { command: 'curl x', dangerously_disable_sandbox: true },
	isDestructive: false,
	escalation: { sandboxEscape: true },
}

describe('a resumed escalation', () => {
	it('runs when it reaches exactly what was reviewed', () => {
		expect(
			escalationRefusal({ outsidePaths: ['/outside/a.txt'] }, shownRead, false, undefined, 'r1'),
		).toBeUndefined()
		expect(escalationRefusal({ sandboxEscape: true }, shownEscape, false, ['b1'], 'b1')).toBe(
			undefined,
		)
	})

	it('is refused for a path the reviewer was not shown', () => {
		expect(
			escalationRefusal({ outsidePaths: ['/outside/b.txt'] }, shownRead, false, undefined, 'r1'),
		).toMatch(/does not cover what it reaches now/)
		expect(
			escalationRefusal(
				{ outsidePaths: ['/outside/a.txt'] },
				{ ...shownRead, escalation: undefined },
				false,
				undefined,
				'r1',
			),
		).toMatch(/does not cover/)
	})

	it('is refused when nobody reviewed it or its input was modified afterwards', () => {
		expect(
			escalationRefusal({ outsidePaths: ['/outside/a.txt'] }, undefined, false, undefined, 'r1'),
		).toMatch(/does not cover/)
		expect(
			escalationRefusal({ outsidePaths: ['/outside/a.txt'] }, shownRead, true, undefined, 'r1'),
		).toMatch(/does not cover/)
	})

	it('is refused for an escape the durable decision did not confirm by id', () => {
		expect(escalationRefusal({ sandboxEscape: true }, shownEscape, false, undefined, 'b1')).toMatch(
			/needs a person to confirm it/,
		)
		expect(escalationRefusal({ sandboxEscape: true }, shownEscape, false, ['other'], 'b1')).toMatch(
			/needs a person to confirm it/,
		)
	})

	it('has nothing to say about a call that crosses nothing', () => {
		expect(escalationRefusal(undefined, undefined, true, undefined, 'x')).toBeUndefined()
	})
})
