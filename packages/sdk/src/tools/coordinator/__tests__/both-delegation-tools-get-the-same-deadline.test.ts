import { describe, expect, it } from 'vitest'

import { DEFAULT_TOOL_TIMEOUT_MS } from '../../../runtime/query/executor.js'
import { buildAgentTool } from '../agent.js'
import { buildCoordinatorTools, DELEGATION_TIMEOUT_MS } from '../index.js'

/**
 * Two tools delegate a whole agent run and block on it. One declared a
 * deadline and the other declared nothing, which is not "no deadline" — it
 * is the executor's 120-second default, a sensible bound for a tool call
 * and an absurd one for an agent.
 *
 * The measurement is in `DELEGATION_TIMEOUT_MS`'s own docblock: three
 * delegated children took 4m21s, 5m58s and 8m04s, and all three parents
 * gave up at 120s. That fix reached one of the two surfaces.
 *
 * These tests are about the pair, not about a number. A test asserting
 * each tool's timeout separately passes while they drift apart, and
 * drifting apart is the defect.
 */

function agentTool() {
	return buildAgentTool({
		allowedAgentIds: ['researcher'],
		gateway: {} as never,
		workingDirectory: '/tmp',
	})
}

function createTaskTool() {
	const tools = buildCoordinatorTools({
		allowedAgentIds: ['researcher'],
		gateway: {} as never,
		workingDirectory: '/tmp',
	})
	const found = tools.find((t) => t.name === 'create_task')
	if (!found) throw new Error('create_task not built; this test is aimed at the wrong tool')
	return found
}

describe('the two delegation tools', () => {
	it('agree on how long a delegated run may take', () => {
		// The pair is the assertion. Whichever way a future change moves one
		// deadline, this fails unless it moves the other — which is exactly
		// what did not happen the first time.
		expect(agentTool().timeoutMs).toBe(createTaskTool().timeoutMs)
	})

	it('bound a delegated run by the hour rather than by the tool-call default', () => {
		// Asserted against the executor default rather than against
		// `DELEGATION_TIMEOUT_MS` alone: a test that only compares the tool to
		// the constant it was built from still passes if the tool declares
		// nothing and something else supplies the same number.
		expect(agentTool().timeoutMs).toBe(DELEGATION_TIMEOUT_MS)
		expect(agentTool().timeoutMs).toBeGreaterThan(DEFAULT_TOOL_TIMEOUT_MS)
	})

	it('declares a deadline at all, which is the thing that was missing', () => {
		// `undefined` here is the original bug, and it is invisible in any
		// assertion phrased as "is not too small" — undefined is not a number
		// and does not fail a comparison, it fails the comparison's premise.
		expect(agentTool().timeoutMs).toBeTypeOf('number')
	})
})
