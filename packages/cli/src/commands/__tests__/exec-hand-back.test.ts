/**
 * A task the model handed back to a person reaches a script that drives
 * `namzu exec`: its own exit status (3), an optional `handedBack` key on the
 * result of `--output-format json`, and the same key on the `done` line of the `--json` stream.
 * The flag and the setting turn it on; neither one, nothing is passed down.
 */

import { describe, expect, it, vi } from 'vitest'

import { EXIT_HANDED_BACK } from '../../exit-codes.js'
import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import type { CommandContext } from '../types.js'

const handedBack = {
	kind: 'conflict',
	blocker: 'the check asserts 3 and the request says 4',
	tried: 'read both and ran the check',
	needed: 'say which number is right',
}

let turns: object[][] = []
let sessionOptions: Record<string, unknown> | undefined
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
	createAgentSession: vi.fn(async (_prefs: unknown, _detected: unknown, options: never) => {
		sessionOptions = options
		return sessionStub
	}),
}))

const { execCommand } = await import('../exec.js')

async function stdoutOf(work: () => Promise<number>): Promise<{ code: number; out: string }> {
	const lines: string[] = []
	const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		lines.push(String(chunk))
		return true
	})
	try {
		const code = await work()
		return { code, out: lines.join('') }
	} finally {
		spy.mockRestore()
	}
}

function context(config: object = {}) {
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
			config,
		} as unknown as CommandContext,
	}
}

describe('exec when the model hands the task back', () => {
	it('exits 3, keys the result', async () => {
		turns = [[{ kind: 'done', text: '', stopReason: 'end_turn', handedBack }]]
		const { ctx } = context()
		const { code, out } = await stdoutOf(() =>
			execCommand.handler({
				ctx,
				rawArgs: ['--hand-back', '--output-format', 'json', 'make it pass'],
			}),
		)
		expect(code).toBe(EXIT_HANDED_BACK)
		expect(EXIT_HANDED_BACK).toBe(3)
		expect(JSON.parse(out)).toMatchObject({ handedBack })
		expect(sessionOptions).toMatchObject({ handBack: true })
	})

	it('exits 0 with no handedBack key for a turn that was not handed back', async () => {
		turns = [[{ kind: 'done', text: 'fixed', stopReason: 'end_turn' }]]
		const { ctx } = context()
		const { code, out } = await stdoutOf(() =>
			execCommand.handler({
				ctx,
				rawArgs: ['--hand-back', '--output-format', 'json', 'make it pass'],
			}),
		)
		expect(code).toBe(0)
		expect(JSON.parse(out)).not.toHaveProperty('handedBack')
	})

	it('offers the tool only when the flag or the setting says so', async () => {
		turns = [[{ kind: 'done', text: 'x', stopReason: 'end_turn' }]]
		await execCommand.handler({ ctx: context().ctx, rawArgs: ['hi'] })
		expect(sessionOptions).not.toHaveProperty('handBack')
		turns = [[{ kind: 'done', text: 'x', stopReason: 'end_turn' }]]
		await execCommand.handler({
			ctx: context({ handBack: { enabled: true } }).ctx,
			rawArgs: ['hi'],
		})
		expect(sessionOptions).toMatchObject({ handBack: true })
	})

	it('a failed turn is still 1, never 3', async () => {
		turns = [[{ kind: 'done', text: 'partial', stopReason: 'max_iterations' }]]
		const code = await execCommand.handler({
			ctx: context().ctx,
			rawArgs: ['--hand-back', 'make it pass'],
		})
		expect(code).toBe(1)
	})
})
