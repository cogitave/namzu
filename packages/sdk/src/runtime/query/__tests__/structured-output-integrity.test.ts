import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MockLLMProvider } from '../../../provider/mock.js'
import { generateTurnId } from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { memorySession, terminalRecords } from './support/session.js'

function fixture(input: Record<string, unknown>, schema: z.ZodType, reviewed: boolean) {
	const provider = new MockLLMProvider({
		turns: [{ toolCalls: [{ name: 'structured_output', args: input }] }],
	})
	const review = vi.fn((_output: unknown) => ({ accept: true as const }))
	const params = {
		...memorySession(),
		provider,
		toolsets: [],
		agentId: 'structured-integrity',
		agentName: 'Structured integrity',
		messages: [{ role: 'user' as const, content: 'Return the structured result.' }],
		workingDirectory: process.cwd(),
		turnId: generateTurnId(),
		turnConfig: {
			model: 'mock',
			tokenBudget: 100_000,
			timeoutMs: 10_000,
			maxIterations: 3,
		},
		structuredOutput: { schema, ...(reviewed ? { review } : {}) },
	}
	return { params, provider, review }
}

describe.each([false, true])('tool structured result integrity (reviewer: %s)', (reviewed) => {
	it.each([
		{ label: 'default cap', maxToolOutputChars: undefined, size: 50_000 },
		{ label: 'small custom cap', maxToolOutputChars: 100, size: 2_000 },
	])('fails closed when $label truncates a validated receipt', async (options) => {
		const f = fixture({ text: 'x'.repeat(options.size) }, z.object({ text: z.string() }), reviewed)
		const run = await drainQuery({
			...f.params,
			maxToolOutputChars: options.maxToolOutputChars,
		})

		expect(run.status).toBe('failed')
		expect(run.stopReason).toBe('error')
		expect(run.structuredOutput).toBeUndefined()
		expect(run.lastError).toContain('intact JSON tool result')
		expect(f.review).not.toHaveBeenCalled()
		expect(f.provider.requests).toHaveLength(1)
		const terminal = await terminalRecords(f.params.sessionLog)
		expect(terminal).toHaveLength(1)
		expect(terminal[0]?.type).toBe('turn_failed')
		expect(terminal[0]?.settlement.structuredOutput).toBeUndefined()
		expect(terminal[0]?.settlement.resultSource).not.toBe('structured_output')
	})

	it.each([
		{ label: 'disabled cap', maxToolOutputChars: 0, size: 50_000 },
		{ label: 'sufficient custom cap', maxToolOutputChars: 60_000, size: 50_000 },
		{ label: 'default cap with a smaller result', maxToolOutputChars: undefined, size: 2_000 },
	])('preserves an intact receipt with $label', async (options) => {
		const output = { text: 'x'.repeat(options.size) }
		const f = fixture(output, z.object({ text: z.string() }), reviewed)
		const run = await drainQuery({
			...f.params,
			maxToolOutputChars: options.maxToolOutputChars,
		})

		expect(run.status).toBe('completed')
		expect(run.stopReason).toBe('end_turn')
		expect(run.structuredOutput).toEqual(output)
		expect(run.result).toBe(JSON.stringify(output))
		expect(f.review).toHaveBeenCalledTimes(reviewed ? 1 : 0)
		expect(f.provider.requests).toHaveLength(1)
		const terminal = await terminalRecords(f.params.sessionLog)
		expect(terminal).toHaveLength(1)
		expect(terminal[0]?.type).toBe('turn_completed')
		expect(terminal[0]?.settlement.structuredOutput).toEqual(output)
		expect(terminal[0]?.settlement.resultSource).toBe('structured_output')
	})

	it('publishes the serialized schema transform without validating it twice', async () => {
		const transform = vi.fn((value: { score: number }) => ({ score: value.score + 1 }))
		const f = fixture({ score: 2 }, z.object({ score: z.number() }).transform(transform), reviewed)
		const run = await drainQuery(f.params)

		expect(run.status).toBe('completed')
		expect(run.structuredOutput).toEqual({ score: 3 })
		expect(transform).toHaveBeenCalledTimes(1)
		if (reviewed) expect(f.review).toHaveBeenCalledWith({ score: 3 }, expect.anything())
	})

	it('does not bypass result screening to recover the original validated value', async () => {
		const f = fixture({ score: 2 }, z.object({ score: z.number() }), reviewed)
		const screen = vi.fn(() => ({ action: 'rewrite' as const, output: '[redacted result]' }))
		const run = await drainQuery({ ...f.params, toolResultGuardrails: [screen] })

		expect(screen).toHaveBeenCalledTimes(1)
		expect(run.messages.find((message) => message.role === 'tool')?.content).toBe(
			'[redacted result]',
		)
		expect(run.status).toBe('failed')
		expect(run.structuredOutput).toBeUndefined()
		expect(f.review).not.toHaveBeenCalled()
	})
})
