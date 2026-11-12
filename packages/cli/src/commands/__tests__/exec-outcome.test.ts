/**
 * The turn's outcome record reaches a script that drives `namzu exec`: on the
 * final result object of `--output-format json`, and on the `done` line of the
 * stream of `--json`.
 */

import { describe, expect, it, vi } from 'vitest'

import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import type { CommandContext } from '../types.js'

const record = {
	verdict: 'unchecked',
	basis: 'calls',
	changes: { total: 1, paths: ['a.ts'], outsideKnownTools: false },
	checks: [],
}

const mismatch = {
	claim: 'tests',
	said: 'the tests pass',
	quote: 'All tests pass',
	record: 'unchecked',
	recordSays: 'files changed and no check ran',
}

let turns: object[][] = []
const sessionStub = fakeAgentSession({
	send: () =>
		(async function* () {
			for (const event of turns.shift() ?? []) yield event as never
		})(),
})

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
		detected: [],
	})),
	createAgentSession: vi.fn(async () => sessionStub),
}))

const { execCommand } = await import('../exec.js')
const { execJsonCommand } = await import('./exec-json-command.js')

function context(): { ctx: CommandContext; printed: unknown[] } {
	const printed: unknown[] = []
	return {
		printed,
		ctx: {
			formatter: {
				name: 'json' as const,
				print: (value: unknown) => printed.push(value),
				info: () => {},
				error: () => {},
			},
			config: {},
		} as unknown as CommandContext,
	}
}

async function stdoutOf(work: () => Promise<number>): Promise<string> {
	const lines: string[] = []
	const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		lines.push(String(chunk))
		return true
	})
	try {
		await work()
		return lines.join('')
	} finally {
		spy.mockRestore()
	}
}

describe('exec --output-format json', () => {
	const resultOf = async (rawArgs: string[]): Promise<Record<string, unknown>> => {
		const out = await stdoutOf(() => execCommand.handler({ ctx: context().ctx, rawArgs }))
		return JSON.parse(out) as Record<string, unknown>
	}

	it('carries the outcome on the result', async () => {
		turns = [[{ kind: 'done', text: 'fixed', stopReason: 'end_turn', outcome: record }]]
		expect(await resultOf(['--output-format', 'json', 'fix it'])).toMatchObject({
			text: 'fixed',
			outcome: record,
		})
	})

	it('carries a claim the record contradicts, beside the outcome', async () => {
		turns = [
			[
				{
					kind: 'done',
					text: 'All tests pass.',
					stopReason: 'end_turn',
					outcome: record,
					claimMismatch: mismatch,
				},
			],
		]
		expect(await resultOf(['--output-format', 'json', 'fix it'])).toMatchObject({
			outcome: record,
			claimMismatch: mismatch,
		})
	})

	it('has no claimMismatch key when the answer contradicts nothing', async () => {
		turns = [[{ kind: 'done', text: 'fixed', stopReason: 'end_turn', outcome: record }]]
		expect(await resultOf(['--output-format', 'json', 'fix it'])).not.toHaveProperty(
			'claimMismatch',
		)
	})

	it('has none when the turn kept none', async () => {
		turns = [[{ kind: 'done', text: 'hi', stopReason: 'end_turn' }]]
		const result = await resultOf(['--output-format', 'json', 'hi'])
		expect(result.text).toBe('hi')
		expect(result).not.toHaveProperty('outcome')
	})
})

describe('exec --json', () => {
	it('writes the outcome on the done line', async () => {
		turns = [[{ kind: 'done', text: 'fixed', stopReason: 'end_turn', outcome: record }]]
		const out = await stdoutOf(() =>
			execJsonCommand.handler({
				ctx: context().ctx,
				rawArgs: ['--session', '40e7c721-43ca-4da8-a737-2e03c9347063', 'fix it'],
			}),
		)
		const done = out
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { kind: string; outcome?: unknown })
			.find((line) => line.kind === 'done')
		expect(done?.outcome).toEqual(record)
	})
})
