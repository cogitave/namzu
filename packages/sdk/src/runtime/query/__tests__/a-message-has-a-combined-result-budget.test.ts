import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import type { ToolManager } from '../../../toolsets/manager.js'
import type { TurnId } from '../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import { generateSessionId } from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import {
	DEFAULT_MAX_TOOL_OUTPUT_CHARS_PER_MESSAGE,
	SPILL_MARKER,
	fitResultsToMessageBudget,
} from '../tool-output-budget.js'
import { ToolingBootstrap } from '../tooling.js'

/**
 * The per-result cap alone lets eight parallel calls put 320,000 characters in
 * front of the model. The combined cap for one assistant message is 200,000,
 * and the replacement is decided once, when the batch settles, so the history
 * never holds anything else.
 */

const TURN_ID = '9c2a5358-a2bf-4868-9ffc-2a9cc8908f99' as TurnId
const SESSION_ID = generateSessionId()

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return {
		...stub,
		child: vi.fn(() => ({ ...stub, child: vi.fn() })),
	} as unknown as Logger
}

function calls(names: readonly string[]): ChatCompletionResponse {
	return {
		id: 'r',
		model: 'm',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: names.map((name, i) => ({
				id: `call_${i}`,
				type: 'function' as const,
				function: { name, arguments: JSON.stringify({ i }) },
			})),
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

const tempDirs: string[] = []
afterEach(() => {
	for (const dir of tempDirs.splice(0)) removeTempDir(dir)
})

function bootstrap(opts: {
	sizes: readonly number[]
	perMessage?: number
	selfLimiting?: string
}) {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-message-budget-'))
	tempDirs.push(dir)
	const tools = {
		get: vi.fn((name: string) => ({
			name,
			isConcurrencySafe: () => true,
			isReadOnly: () => true,
			isDestructive: () => false,
			...(name === opts.selfLimiting ? { selfLimitingOutput: true } : {}),
		})),
		execute: vi.fn(async (_name: string, input: { i: number }) => ({
			success: true,
			output: String(input.i).repeat(opts.sizes[input.i] ?? 0),
		})),
		has: vi.fn(() => true),
		listNames: vi.fn(() => []),
		availability: vi.fn(() => 'active'),
	} as unknown as ToolManager
	const exec = ToolingBootstrap.init(
		{
			sessionId: SESSION_ID,
			tools,
			turnId: TURN_ID,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			toolOutputDir: dir,
			// Raised past the batch, so only the per-message cap can act.
			maxToolOutputChars: 100_000,
			...(opts.perMessage !== undefined ? { maxToolOutputCharsPerMessage: opts.perMessage } : {}),
		},
		new ActivityStore(TURN_ID, {
			enabled: false,
			trackToolCalls: false,
			trackLlmTurns: false,
		}),
		async () => {},
		makeLogger(),
	)
	return { exec, dir }
}

const total = (outputs: readonly string[]) => outputs.reduce((n, o) => n + o.length, 0)

describe('one assistant message has a combined tool-result budget', () => {
	it('defaults to 200,000 characters', () => {
		expect(DEFAULT_MAX_TOOL_OUTPUT_CHARS_PER_MESSAGE).toBe(200_000)
	})

	it('replaces the largest results first until the batch fits, and keeps the full text', async () => {
		// 8 x 40,000 = 320,000 characters in one message.
		const { exec } = bootstrap({
			sizes: [40_000, 40_000, 40_000, 40_000, 40_000, 40_000, 40_000, 40_000],
		})
		const batch = await exec.executeBatch(calls(Array.from({ length: 8 }, () => 'probe')))
		const outputs = batch.results.map((r) => r.output)
		expect(total(outputs)).toBeLessThanOrEqual(200_000)
		const replaced = outputs.filter((o) => o.includes(SPILL_MARKER))
		expect(replaced.length).toBeGreaterThanOrEqual(3)
		// Ties go to the earlier call, so the same batch replaces the same ones.
		expect(outputs[0]).toContain(SPILL_MARKER)
		expect(outputs[7]).not.toContain(SPILL_MARKER)
		const path = /written to: (.+)$/m.exec(outputs[0] as string)?.[1] as string
		expect(readFileSync(path, 'utf8')).toBe('0'.repeat(40_000))
		// What goes to the history is the replacement, not the original.
		expect(batch.messages.map((m) => String(m.content))).toEqual(outputs)
	})

	it('leaves a batch under the cap untouched', async () => {
		const { exec } = bootstrap({ sizes: [40_000, 40_000, 40_000] })
		const batch = await exec.executeBatch(calls(['probe', 'probe', 'probe']))
		expect(batch.results.map((r) => r.output.length)).toEqual([40_000, 40_000, 40_000])
	})

	it('is the same on every run of the same batch', async () => {
		const sizes = [30_000, 90_000, 50_000, 70_000]
		const a = await bootstrap({ sizes }).exec.executeBatch(calls(['p', 'p', 'p', 'p']))
		const b = await bootstrap({ sizes }).exec.executeBatch(calls(['p', 'p', 'p', 'p']))
		const shape = (batch: typeof a) => batch.results.map((r) => r.output.includes(SPILL_MARKER))
		expect(shape(a)).toEqual(shape(b))
		// 90,000 and 70,000 are the largest; dropping them lands at 80,000.
		expect(shape(a)).toEqual([false, true, false, false])
	})

	it('honours a host-set cap, and 0 turns it off', async () => {
		const sizes = [40_000, 40_000]
		const tight = await bootstrap({
			sizes,
			perMessage: 50_000,
		}).exec.executeBatch(calls(['p', 'p']))
		expect(total(tight.results.map((r) => r.output))).toBeLessThanOrEqual(50_000)
		const off = await bootstrap({ sizes, perMessage: 0 }).exec.executeBatch(calls(['p', 'p']))
		expect(off.results.map((r) => r.output.length)).toEqual([40_000, 40_000])
	})

	it('never replaces a tool that limits its own output', async () => {
		const { exec } = bootstrap({
			sizes: [90_000, 90_000, 90_000],
			selfLimiting: 'paged',
		})
		const batch = await exec.executeBatch(calls(['paged', 'p', 'p']))
		expect(batch.results[0]?.output.length).toBe(90_000)
		// The others alone are 180,000, which fits: nothing else was replaced either.
		expect(batch.results[1]?.output.length).toBe(90_000)
	})
})

describe('fitResultsToMessageBudget', () => {
	const item = (id: string, size: number, replaceable = true) => ({
		toolCallId: id,
		toolName: 't',
		output: 'x'.repeat(size),
		replaceable,
	})

	it('does nothing under the cap or with the cap off', () => {
		const items = [item('a', 100), item('b', 100)]
		expect(fitResultsToMessageBudget(items, { maxChars: 1000 }).size).toBe(0)
		expect(fitResultsToMessageBudget(items, { maxChars: 0 }).size).toBe(0)
	})

	it('does not count what it cannot replace', () => {
		const items = [item('a', 900, false), item('b', 100)]
		expect(fitResultsToMessageBudget(items, { maxChars: 500 }).size).toBe(0)
	})

	it('keeps the path of a result that was already spilled', () => {
		const spilled = `${'y'.repeat(5000)}\n${SPILL_MARKER} /somewhere/abc.txt\nmore`
		const out = fitResultsToMessageBudget(
			[{ toolCallId: 'a', toolName: 't', output: spilled, replaceable: true }],
			{ maxChars: 100 },
		)
		expect(out.get('a')?.output).toContain(`${SPILL_MARKER} /somewhere/abc.txt`)
		expect(out.get('a')?.output.length).toBeLessThan(spilled.length)
	})
})
