/**
 * `--gate '<command>'` — the flag that makes `reviewAnswer` reachable.
 *
 * The kernel's answer-review loop was complete and supplied by nothing: an
 * operator who wanted "don't finish until the build passes" had to write
 * TypeScript. So the load-bearing tests here are reachability ones. Delete
 * the gate from either headless command's session options and the third
 * block fails; a suite that only checked the parser would stay green through
 * exactly the defect this flag exists to close.
 */

import { describe, expect, it, vi } from 'vitest'

import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import type { CommandContext } from '../types.js'

const createAgentSession = vi.fn(async () => sessionStub)

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
		detected: [],
	})),
	createAgentSession: (...args: unknown[]) =>
		(createAgentSession as unknown as (...a: unknown[]) => unknown)(...args),
}))

const sessionStub = fakeAgentSession({
	send: () =>
		(async function* () {
			yield { kind: 'done', stopReason: 'end_turn' } as never
		})(),
})

const { buildGate, parseRunFlags } = await import('../run-flags.js')
const { runCommand } = await import('../run.js')
const { runStreamCommand } = await import('../run-stream.js')

function contextCapturing(): CommandContext {
	return {
		formatter: {
			name: 'text' as const,
			print: () => {},
			info: () => {},
			error: () => {},
		},
		config: {},
	} as unknown as CommandContext
}

/** The session options the command handed to `createAgentSession`. */
async function sessionOptionsFor(
	command: { handler: (a: { ctx: CommandContext; rawArgs: readonly string[] }) => Promise<number> },
	rawArgs: readonly string[],
): Promise<Record<string, unknown>> {
	createAgentSession.mockClear()
	await command.handler({ ctx: contextCapturing(), rawArgs })
	expect(createAgentSession).toHaveBeenCalled()
	return (createAgentSession.mock.calls[0] as unknown[])[2] as Record<string, unknown>
}

describe('parsing the flag', () => {
	it('appends rather than replacing, so two gates are two gates', () => {
		const flags = parseRunFlags(['--gate', 'pnpm typecheck', '--gate', 'pnpm test', 'fix it'])
		// Last-wins would run only the tests and report success on a project
		// whose types do not compile.
		expect(flags.gates).toEqual(['pnpm typecheck', 'pnpm test'])
		// And the command lines stay out of the prompt, which is what the whole
		// shared parser exists for.
		expect(flags.rest).toEqual(['fix it'])
	})

	it('reads the equals form and drops an empty one', () => {
		expect(parseRunFlags(['--gate=pnpm test']).gates).toEqual(['pnpm test'])
		expect(parseRunFlags(['--gate', '   ']).gates).toEqual([])
	})

	it('reads the retry budget', () => {
		expect(parseRunFlags(['--gate-retries', '5']).gateRetries).toBe(5)
	})
})

describe('building the reviewer', () => {
	it('builds nothing when no gate was asked for', () => {
		expect(buildGate({ gates: [], gateRetries: null }, '/w')).toBeUndefined()
	})

	it('gives the run a rejection budget that matches the gate', () => {
		const built = buildGate({ gates: ['pnpm test'], gateRetries: 2 }, '/w')
		// The two have to agree. A run whose budget outlasts its gate spends
		// its remaining turns being told the gate has given up.
		expect(built?.maxAnswerReviews).toBe(2)
		expect(typeof built?.reviewAnswer).toBe('function')
	})

	it('ignores a retry count that cannot mean what it says', () => {
		expect(buildGate({ gates: ['x'], gateRetries: 0 }, '/w')?.maxAnswerReviews).toBe(3)
		expect(buildGate({ gates: ['x'], gateRetries: -1 }, '/w')?.maxAnswerReviews).toBe(3)
		expect(buildGate({ gates: ['x'], gateRetries: Number.NaN }, '/w')?.maxAnswerReviews).toBe(3)
	})
})

describe('the gate reaches the run', () => {
	it('is handed to the session by `run`', async () => {
		const options = await sessionOptionsFor(runCommand, ['--gate', 'pnpm test', 'fix the tests'])
		// Deleting the spread in `run.ts` leaves the flag parsed and ignored —
		// an operator gets a run that accepted `--gate` and settled on a red
		// build, with nothing to read that says why.
		expect(typeof options.reviewAnswer).toBe('function')
		expect(options.maxAnswerReviews).toBe(3)
	})

	it('is handed to the session by `run-stream` too', async () => {
		const options = await sessionOptionsFor(runStreamCommand, [
			'--session',
			'ses_gate',
			'--gate',
			'pnpm test',
			'--gate-retries',
			'1',
			'fix the tests',
		])
		// Both, because they share one parser. A flag parsed by the shared
		// parser and honoured by only one command is worse than a flag neither
		// has.
		expect(typeof options.reviewAnswer).toBe('function')
		expect(options.maxAnswerReviews).toBe(1)
	})

	it('leaves a run without gates byte-identical to one before gates existed', async () => {
		const options = await sessionOptionsFor(runCommand, ['fix the tests'])
		// Absent, not `undefined`: the kernel branches on presence, and a key
		// that is always there is a key a future reader has to reason about.
		expect('reviewAnswer' in options).toBe(false)
		expect('maxAnswerReviews' in options).toBe(false)
	})
})
