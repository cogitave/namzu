import { describe, expect, it, vi } from 'vitest'

import { runCommand } from '../run.js'
import type { CommandContext } from '../types.js'

/**
 * `namzu run` exited 0 for six ways of not finishing.
 *
 * `run_failed` is emitted only from the kernel's throw path, so a run stopped
 * by its token budget, its timeout, its iteration cap, a cancellation, or a
 * guardrail arrived as `run_completed` — which this command mapped to "print
 * the text and return 0". The sharp case is the output guardrail: an answer
 * that was REFUSED exited 0 with empty text, so `namzu run … > out.txt &&
 * deploy` went ahead on the empty file.
 */

const sessionStub = {
	hasProvider: true,
	providerSummary: 'mock',
	modelSummary: 'mock-model',
	// A real session always carries this, empty or not. A stub that omits a
	// field production always sets is a fixture that tests a system which does
	// not ship.
	instructionFiles: [] as readonly string[],
	skippedInstructionFiles: [] as readonly { path: string; reason: string }[],
	send: undefined as unknown,
}

vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 2, provider: 'mock', subagents: { active: [] } },
		detected: [],
	})),
	createAgentSession: vi.fn(async () => sessionStub),
}))

function contextCapturing(): { ctx: CommandContext; printed: string[]; errors: string[] } {
	const printed: string[] = []
	const errors: string[] = []
	const ctx = {
		formatter: {
			name: 'text' as const,
			print: (d: unknown) => printed.push(String((d as { text?: string })?.text ?? d)),
			info: () => {},
			error: (e: unknown) => errors.push(String((e as { message?: string })?.message ?? e)),
		},
		config: {},
	} as unknown as CommandContext
	return { ctx, printed, errors }
}

function streaming(events: unknown[]): void {
	sessionStub.send = () =>
		(async function* () {
			for (const e of events) yield e
		})()
}

async function runWith(events: unknown[]): Promise<{
	code: number
	printed: string[]
	errors: string[]
}> {
	streaming(events)
	const { ctx, printed, errors } = contextCapturing()
	const code = (await runCommand.handler({ rawArgs: ['hello'], ctx } as never)) as number
	return { code, printed, errors }
}

describe('namzu run exit code reflects whether the run finished', () => {
	it('exits 0 when the model answered', async () => {
		const { code, printed } = await runWith([
			{ kind: 'delta', text: 'the answer' },
			{ kind: 'done', stopReason: 'end_turn' },
		])

		expect(code).toBe(0)
		expect(printed.join('')).toContain('the answer')
	})

	it('exits 1 when an output guardrail refused the answer', async () => {
		// The empty-output case. Exiting 0 here told a shell script the run had
		// succeeded and handed it nothing.
		const { code, errors } = await runWith([{ kind: 'done', stopReason: 'output_guardrail' }])

		expect(code).toBe(1)
		expect(errors.join('')).toContain('output_guardrail')
	})

	it('exits 1 but still prints what it got when the iteration cap cut it short', async () => {
		// Partial output is real output — a caller who piped it wants what
		// there is. What they also need is for `$?` to say it is partial.
		const { code, printed, errors } = await runWith([
			{ kind: 'delta', text: 'half an ans' },
			{ kind: 'done', stopReason: 'max_iterations' },
		])

		expect(code).toBe(1)
		expect(printed.join('')).toContain('half an ans')
		expect(errors.join('')).toContain('partial')
	})

	it('still exits 1 on an explicit error event', async () => {
		const { code } = await runWith([{ kind: 'error', message: 'provider exploded' }])

		expect(code).toBe(1)
	})
})
