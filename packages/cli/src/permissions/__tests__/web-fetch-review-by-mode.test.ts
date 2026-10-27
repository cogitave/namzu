/**
 * A `web_fetch` the gate sent to review is put through the review handler of
 * each permission mode: the person is asked in `prompt` and `accept-edits`,
 * plan mode refuses, and only `bypass` goes on without a question. Every gate
 * an entry point builds comes from the one `cliGate`.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	type CheckpointId,
	type HITLDecisionRequest,
	PLAN_MODE_REFUSAL,
	type ToolCallSummary,
	type ToolReviewAnswer,
	type TurnId,
	createReviewHandler,
	generateSessionId,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import type { PermissionMode } from '../mode.js'

const fetchCall: ToolCallSummary = {
	id: 'call_web_fetch',
	name: 'web_fetch',
	input: { url: 'https://example.com/a', prompt: 'what is on the page' },
	isDestructive: false,
}

const request = (): HITLDecisionRequest => ({
	sessionId: generateSessionId(),
	type: 'tool_review',
	turnId: 'f8223c92-2ebb-4961-8f5c-51dffd77693e' as TurnId,
	checkpointId: '82267e66-99cd-4ee0-8a15-b8108f6fce73' as CheckpointId,
	toolCalls: [fetchCall],
})

async function run(mode: PermissionMode) {
	let asked = 0
	const handler = createReviewHandler({
		mode,
		exempt: () => false,
		remembered: { all: false },
		prompt: async (): Promise<ToolReviewAnswer> => {
			asked += 1
			return { kind: 'approve' }
		},
	})
	const outcome = await handler(request())
	return { outcome, asked }
}

describe('a reviewed web_fetch under each mode', () => {
	for (const mode of ['prompt', 'accept-edits'] as const) {
		it(`asks the person in ${mode}`, async () => {
			const { outcome, asked } = await run(mode)
			expect(asked).toBe(1)
			expect(outcome).toEqual({ action: 'approve_tools' })
		})
	}

	it('refuses in plan mode without asking', async () => {
		const { outcome, asked } = await run('plan')
		expect(asked).toBe(0)
		expect(outcome).toEqual({ action: 'reject_tools', feedback: PLAN_MODE_REFUSAL })
	})

	it('goes on without a question only in bypass', async () => {
		const { outcome, asked } = await run('bypass')
		expect(asked).toBe(0)
		expect(outcome).toEqual({ action: 'approve_tools' })
	})
})

describe('every gate comes from cliGate', () => {
	const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
	for (const file of ['tui/agent.ts', 'pals/agent-session.ts']) {
		it(`${file} builds its authorization gate only through it`, () => {
			const source = readFileSync(join(root, file), 'utf8')
			const uses = [...source.matchAll(/authorizationGate:\s*([^\n,]+)/g)].map((m) => m[1] ?? '')
			expect(uses.length).toBeGreaterThan(0)
			for (const use of uses) expect(use).toMatch(/^(gateFor|cliGate)\(/)
		})
	}
})
