import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type Context,
	type Span,
	type SpanStatus,
	SpanStatusCode,
	type Tracer,
	trace,
} from '@opentelemetry/api'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { GENAI, NAMZU, agentTurnSpanName } from '../../../telemetry/attributes.js'
import { defineTool } from '../../../tools/defineTool.js'
import { autoApproveHandler } from '../../../types/hitl/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'

/**
 * A run's root span is the one an operator actually looks at, and its
 * terminal half had never been asserted for a real run.
 *
 * `attachment-resolution-cancellation-reaches-run.test.ts` counts `end()`
 * once on one cancellation path; `trace-parenting.test.ts` records the
 * parents spans are started with and stubs `setStatus` out; the only
 * `setStatus` assertion in the suite drives `ResultAssembler.handleError`
 * against a hand-built `recorder`. So the attributes and the verdict the loop
 * puts on the ROOT of a live run — the numbers a dashboard reads and the
 * status that decides whether the run lands in an error panel — were
 * unobserved.
 *
 * What is asserted here is deliberately the terminal write only: the setup
 * attributes are covered by their own fixtures, and the claim in question is
 * what the span says once the run has settled.
 */

const dirs: string[] = []

afterEach(async () => {
	trace.disable()
	await removeTempDirs(dirs)
	dirs.length = 0
})

interface WrittenSpan {
	name: string
	attributes: Record<string, unknown>
	status: SpanStatus | undefined
	ended: number
	exceptions: number
}

/** A span that remembers everything written to it. */
function recordingSpan(name: string): Span & { written: WrittenSpan } {
	const written: WrittenSpan = {
		name,
		attributes: {},
		status: undefined,
		ended: 0,
		exceptions: 0,
	}
	const self = {
		spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }),
		setAttribute: (key: string, value: unknown) => {
			written.attributes[key] = value
			return self
		},
		setAttributes: (attributes: Record<string, unknown>) => {
			Object.assign(written.attributes, attributes)
			return self
		},
		addEvent: () => self,
		setStatus: (status: SpanStatus) => {
			written.status = status
			return self
		},
		updateName: () => self,
		end: () => {
			written.ended += 1
		},
		isRecording: () => true,
		recordException: () => {
			written.exceptions += 1
		},
		addLink: () => self,
		addLinks: () => self,
		written,
	} as unknown as Span & { written: WrittenSpan }
	return self
}

/** Every span the run opens, in order, with what each was written. */
function recordingTracer(): { tracer: Tracer; spans: (Span & { written: WrittenSpan })[] } {
	const spans: (Span & { written: WrittenSpan })[] = []
	const tracer = {
		startSpan: (name: string, _options?: unknown, _ctx?: Context) => {
			const span = recordingSpan(name)
			spans.push(span)
			return span
		},
		startActiveSpan: (() => {
			throw new Error('startActiveSpan does not hold context across yield; not used here')
		}) as never,
	} as unknown as Tracer
	return { tracer, spans }
}

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-root-span-'))
	dirs.push(dir)
	return dir
}

function echoRegistry(): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register(
		defineTool({
			name: 'echo',
			description: 'echoes the text back',
			inputSchema: z.object({ text: z.string() }),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: 'hi' }),
		}),
	)
	return tools
}

async function runOnce(signal?: AbortSignal): Promise<{
	root: Span & { written: WrittenSpan }
	spans: (Span & { written: WrittenSpan })[]
}> {
	const { tracer, spans } = recordingTracer()
	trace.setGlobalTracerProvider({ getTracer: () => tracer })

	await drainQuery({
		provider: new MockLLMProvider({
			turns: [
				{
					toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'a' } }],
					finishReason: 'tool_calls',
				},
				{
					text: 'done',
					usage: { promptTokens: 31, completionTokens: 12, totalTokens: 43 },
				},
			],
		}),
		tools: echoRegistry(),
		agentId: 'agent_root_span',
		agentName: 'Root span agent',
		messages: [{ role: 'user', content: 'go' }],
		workingDirectory: await workdir(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		...(signal ? { signal } : {}),
		resumeHandler: autoApproveHandler,
		authorizationGate: {
			enabled: true,
			rules: [{ type: 'allow_by_name', toolNames: ['echo'] }],
			allowReadOnlyTools: false,
			denyDangerousPatterns: false,
			logDecisions: false,
		},
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			maxResponseTokens: 256,
		},
	} as unknown as QueryParams)

	const root = spans.filter((span) => span.written.name === agentTurnSpanName('Root span agent'))
	if (root.length !== 1) {
		throw new Error(`expected exactly one root span, got ${root.length}`)
	}
	return { root: root[0] as Span & { written: WrittenSpan }, spans }
}

describe('the root span of a run that answered', () => {
	it('records the terminal attributes a dashboard reads', async () => {
		const { root } = await runOnce()

		expect(root.written.attributes[NAMZU.TURN_STATUS]).toBe('end_turn')
		expect(root.written.attributes[NAMZU.ITERATION]).toBeGreaterThan(0)
		expect(root.written.attributes[GENAI.USAGE_INPUT_TOKENS]).toBe(31)
		expect(root.written.attributes[GENAI.USAGE_OUTPUT_TOKENS]).toBe(12)
	})

	it('closes OK, once', async () => {
		const { root } = await runOnce()

		// OK, not UNSET and not ERROR: an exporter that never sees a status
		// leaves the span in whatever the backend defaults to, and a
		// successful run landing in an error panel is the failure this
		// prevents.
		expect(root.written.status).toEqual({ code: SpanStatusCode.OK })
		expect(root.written.ended).toBe(1)
		expect(root.written.exceptions).toBe(0)
	})

	it('still closes the span, exactly once, when the run is cancelled', async () => {
		const caller = new AbortController()
		const { root } = await runOnce(caller.signal)
		caller.abort()

		expect(root.written.ended).toBe(1)
	})
})

describe('the root span of a run that failed', () => {
	it('closes ERROR and keeps the exception', async () => {
		const { tracer, spans } = recordingTracer()
		trace.setGlobalTracerProvider({ getTracer: () => tracer })

		await drainQuery({
			provider: new MockLLMProvider({ turns: [{ error: { message: 'the model fell over' } }] }),
			tools: new ToolRegistry(),
			agentId: 'agent_root_span',
			agentName: 'Root span agent',
			messages: [{ role: 'user', content: 'go' }],
			workingDirectory: await workdir(),
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			resumeHandler: autoApproveHandler,
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 2,
				maxResponseTokens: 256,
			},
		} as unknown as QueryParams)

		const root = spans.find(
			(span) => span.written.name === agentTurnSpanName('Root span agent'),
		) as Span & { written: WrittenSpan }
		expect(root).toBeDefined()
		expect(root.written.attributes[NAMZU.TURN_STATUS]).toBe('error')
		expect(root.written.status?.code).toBe(SpanStatusCode.ERROR)
		expect(root.written.exceptions).toBeGreaterThan(0)
		expect(root.written.ended).toBe(1)
	})
})
