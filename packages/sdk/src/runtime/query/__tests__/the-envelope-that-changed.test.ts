import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import { isEphemeralEvent } from '../../../types/run/events.js'
import type { PrepareStep, RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * A transcript showed one prompt for a run that had asked several
 * questions.
 *
 * `run_started` records a system prompt once, and tool schemas never
 * reached the transcript at all. Meanwhile `prepareStep` rewrites the
 * system text, narrows the tool list or swaps the model between
 * iterations, and a step's skills ride an ephemeral trailing system
 * message. Everything about WHAT was asked could change, and the durable
 * record said it had not.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const call = (id: string): MockTurn => ({
	toolCalls: [{ id, name: 'probe', args: {} }],
	finishReason: 'tool_calls',
})

function tools(extra?: { readonly schemaBody: string }): ToolRegistry {
	const registry = new ToolRegistry()
	registry.register(
		defineTool({
			name: 'probe',
			description: 'probes',
			inputSchema: z.object({ [extra?.schemaBody ?? 'q']: z.string().optional() }),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: 'ok' }),
		}),
	)
	registry.register(
		defineTool({
			name: 'other',
			description: 'other',
			inputSchema: z.object({}),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: 'ok' }),
		}),
	)
	return registry
}

type Envelope = Extract<RunEvent, { type: 'request_envelope' }>

async function run(opts: {
	readonly turns: number
	readonly prepareStep?: PrepareStep
	readonly registry?: ToolRegistry
}): Promise<Envelope[]> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-envelope-'))
	dirs.push(workingDirectory)
	const seen: RunEvent[] = []

	await drainQuery(
		{
			provider: new MockLLMProvider({
				turns: [...Array.from({ length: opts.turns }, (_, i) => call(`c${i}`)), { text: 'done' }],
			}),
			tools: opts.registry ?? tools(),
			runConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 200_000,
				maxIterations: opts.turns + 2,
			},
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('go')],
			workingDirectory,
			sessionId: 'ses_e' as SessionId,
			topicId: 'top_e' as TopicId,
			projectId: 'prj_e' as ProjectId,
			tenantId: 'tnt_e' as TenantId,
			...(opts.prepareStep ? { prepareStep: opts.prepareStep } : {}),
		},
		(event: RunEvent) => {
			seen.push(event)
		},
	)

	return seen.filter((e): e is Envelope => e.type === 'request_envelope')
}

describe('what the model was asked, recorded when it changed', () => {
	it('emits exactly one envelope for a run whose request never changes', async () => {
		// Equality, not `toBeGreaterThan`. An implementation that emitted per
		// iteration satisfies "at least one" and produces a durable log too
		// large to read — which is the failure this suppression exists to
		// prevent, not a performance detail.
		const envelopes = await run({ turns: 4 })

		expect(envelopes).toHaveLength(1)
		expect(envelopes[0]?.iteration).toBe(1)
	})

	it('emits a second one when the system text changes mid-run', async () => {
		const envelopes = await run({
			turns: 5,
			prepareStep: ({ stepNumber }) => (stepNumber >= 3 ? { system: 'a new instruction' } : {}),
		})

		expect(envelopes).toHaveLength(2)
		expect(envelopes[1]?.iteration).toBe(3)
		expect(envelopes[1]?.systemPrompt).toContain('a new instruction')
	})

	it('emits one when the tool list narrows, carrying the narrowed names', async () => {
		const envelopes = await run({
			turns: 4,
			prepareStep: ({ stepNumber }) => (stepNumber >= 2 ? { activeTools: ['probe'] } : {}),
		})

		expect(envelopes.length).toBeGreaterThanOrEqual(2)
		expect(envelopes[0]?.toolNames).toEqual(expect.arrayContaining(['probe', 'other']))
		expect(envelopes[1]?.toolNames).toEqual(['probe'])
	})

	it('emits one when the model changes', async () => {
		const envelopes = await run({
			turns: 4,
			prepareStep: ({ stepNumber }) => (stepNumber >= 2 ? { model: 'mock-2' } : {}),
		})

		expect(envelopes).toHaveLength(2)
		expect(envelopes[1]?.model).toBe('mock-2')
	})

	it('digests the tool SCHEMAS, not just their names', async () => {
		// The change most likely to alter what the model does and least
		// likely to be noticed: a tool whose schema body moved while its name
		// did not. Two runs with identical name lists must produce different
		// digests.
		const first = await run({ turns: 1, registry: tools() })
		const second = await run({ turns: 1, registry: tools({ schemaBody: 'different_field' }) })

		expect(first[0]?.toolNames).toEqual(second[0]?.toolNames)
		expect(first[0]?.toolSchemaDigest).not.toBe(second[0]?.toolSchemaDigest)
	})

	it('is durable, so a transcript can say what was asked', () => {
		// The whole point is the DURABLE record — a live consumer could
		// already read the prompt off the stream. Adding this to
		// `EPHEMERAL_EVENT_TYPES`, where the deltas live, would leave the
		// transcript exactly as uninformative as before while every test
		// above stayed green.
		expect(
			isEphemeralEvent({
				type: 'request_envelope',
				runId: 'run_x',
				iteration: 1,
				model: 'm',
				systemPrompt: '',
				toolNames: [],
				toolSchemaDigest: 'd',
			} as never),
		).toBe(false)
	})

	it('starts fresh for a second run, so one cannot suppress the other', async () => {
		// The suppression key is per RUNNER. Module-level, a second run in the
		// same process with an identical envelope would record nothing at all
		// — and its transcript would have no record of what was asked.
		const first = await run({ turns: 1 })
		const second = await run({ turns: 1 })

		expect(first).toHaveLength(1)
		expect(second).toHaveLength(1)
	})
})
