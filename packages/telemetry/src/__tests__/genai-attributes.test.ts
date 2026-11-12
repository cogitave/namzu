import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	GENAI_NON_CONVENTION_NAMES,
	GENAI_SEMCONV_ATTRIBUTES,
	GENAI_SEMCONV_SCHEMA_URL,
	GENAI_SEMCONV_VERSION,
	MockLLMProvider,
	ToolManager,
	drainQuery,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	generateTurnId,
	setGenAiConventions,
	toolset,
} from '@namzu/sdk'
import { trace } from '@opentelemetry/api'
import {
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { getTelemetry, getTracer, registerTelemetry } from '../provider.js'
import type { SpanProcessorLike } from '../types.js'

/**
 * The kernel's spans, read back from a real in-memory exporter, against the
 * OpenTelemetry GenAI convention at the version the kernel pins (1.41.1).
 *
 * Real tracer provider, real spans from a real turn against the scripted
 * provider; nothing about the spans is faked. No network, no clock.
 */

const PINNED = '1.41.1'
let exporter: InMemorySpanExporter
const dirs: string[] = []

async function register(genAiAttributes?: boolean): Promise<void> {
	exporter = new InMemorySpanExporter()
	await registerTelemetry({
		serviceName: 'genai-test',
		exporterType: 'none',
		...(genAiAttributes !== undefined ? { genAiAttributes } : {}),
		spanProcessors: [new SimpleSpanProcessor(exporter) as unknown as SpanProcessorLike],
	})
}

beforeEach(async () => {
	await register()
})

afterEach(async () => {
	await getTelemetry()?.shutdown()
	trace.disable()
	setGenAiConventions(true)
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const PROMPT = 'PROMPT-TEXT-sentinel'
const REPLY = 'REPLY-TEXT-sentinel'
const TOOL_ARG = 'TOOL-ARG-sentinel'
const TOOL_RESULT = 'TOOL-RESULT-sentinel'

type Turn = NonNullable<ConstructorParameters<typeof MockLLMProvider>[0]>['turns']

async function run(
	turns: Turn,
	options: {
		providerId?: string
		agentName?: string
		parentSpan?: ReturnType<typeof getTracer> extends never
			? never
			: import('@opentelemetry/api').Span
		parentSessionId?: ReturnType<typeof generateSessionId>
		throwInTool?: boolean
	} = {},
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-genai-'))
	dirs.push(dir)
	const provider = new MockLLMProvider({ turns })
	if (options.providerId) (provider as { id: string }).id = options.providerId
	await drainQuery({
		provider,
		toolsets: [
			toolset('test', [
				{
					name: 'lookup',
					description: 'looks something up',
					inputSchema: z.object({ q: z.string().optional() }),
					execute: async () => {
						if (options.throwInTool) throw new RangeError('boom')
						return { success: true, output: TOOL_RESULT }
					},
				} as never,
			]),
		],
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			maxResponseTokens: 256,
			temperature: 0.3,
		},
		agentId: 'agent_genai',
		agentName: options.agentName ?? 'Genai Agent',
		workingDirectory: dir,
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		projectId: generateProjectId(),
		tenantId: generateTenantId(),
		messages: [{ role: 'user', content: PROMPT } as never],
		...(options.parentSpan ? { parentSpan: options.parentSpan } : {}),
		...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
	})
}

const finished = (): ReadableSpan[] => exporter.getFinishedSpans()
const named = (prefix: string): ReadableSpan[] =>
	finished().filter((s) => s.name.startsWith(prefix))
const one = (prefix: string): ReadableSpan => {
	const found = named(prefix)
	expect(found, `spans named ${prefix}`).toHaveLength(1)
	return found[0] as ReadableSpan
}

const TOOL_TURNS: Turn = [
	{ toolCalls: [{ name: 'lookup', args: { q: TOOL_ARG }, id: 'call_1' }] },
	{ text: REPLY },
]

describe('the pin', () => {
	it('is 1.41.1, and the schema URL names it', () => {
		expect(GENAI_SEMCONV_VERSION).toBe(PINNED)
		expect(GENAI_SEMCONV_SCHEMA_URL).toBe(`https://opentelemetry.io/schemas/${PINNED}`)
	})

	it('is stated on the instrumentation scope of every span the kernel starts', async () => {
		await run(TOOL_TURNS)
		const spans = finished()
		expect(spans.length).toBeGreaterThan(3)
		for (const s of spans) {
			expect(s.instrumentationScope.name).toBe('namzu')
			expect(s.instrumentationScope.schemaUrl).toBe(`https://opentelemetry.io/schemas/${PINNED}`)
		}
	})
})

describe('a model call', () => {
	it('carries the convention names, with their types and values', async () => {
		await run([{ text: REPLY }], { providerId: 'anthropic' })
		const a = one('chat ').attributes
		expect(a['gen_ai.operation.name']).toBe('chat')
		expect(a['gen_ai.provider.name']).toBe('anthropic')
		expect(a['gen_ai.request.model']).toBe('mock-model')
		expect(a['gen_ai.request.stream']).toBe(true)
		expect(a['gen_ai.request.temperature']).toBe(0.3)
		expect(a['gen_ai.request.max_tokens']).toBe(256)
		expect(a['gen_ai.response.model']).toBe('mock-model')
		expect(typeof a['gen_ai.response.id']).toBe('string')
		expect(a['gen_ai.response.finish_reasons']).toEqual(['stop'])
		expect(typeof a['gen_ai.usage.input_tokens']).toBe('number')
		expect(typeof a['gen_ai.usage.output_tokens']).toBe('number')
		expect(typeof a['gen_ai.conversation.id']).toBe('string')
		expect(a).not.toHaveProperty('error.type')
	})

	it('leaves the provider name out when no listed value fits, and keeps our own id', async () => {
		await run([{ text: REPLY }], { providerId: 'ollama' })
		const a = one('chat ').attributes
		expect(a).not.toHaveProperty('gen_ai.provider.name')
		expect(a['gen_ai.system']).toBeUndefined() // the model call span never carried it
		expect(one('namzu.agent.turn ').attributes['gen_ai.system']).toBe('ollama')
	})

	it('maps the ids that have a listed value', async () => {
		for (const [id, name] of [
			['bedrock', 'aws.bedrock'],
			['google', 'gcp.gen_ai'],
			['openai', 'openai'],
			['codex', 'openai'],
			['deepseek', 'deepseek'],
		] as const) {
			exporter.reset()
			await run([{ text: REPLY }], { providerId: id })
			expect(one('chat ').attributes['gen_ai.provider.name']).toBe(name)
		}
	})

	it('carries cache reads, cache writes and reasoning, and the input includes them', async () => {
		await run(
			[
				{
					text: REPLY,
					usage: {
						promptTokens: 4,
						completionTokens: 30,
						totalTokens: 34,
						cachedTokens: 20,
						cacheWriteTokens: 7,
						fullPromptTokens: 31,
						reasoningTokens: 12,
					},
				},
			],
			{ providerId: 'anthropic' },
		)
		const a = one('chat ').attributes
		expect(a['gen_ai.usage.input_tokens']).toBe(31)
		expect(a['gen_ai.usage.output_tokens']).toBe(30)
		expect(a['gen_ai.usage.cache_read.input_tokens']).toBe(20)
		expect(a['gen_ai.usage.cache_creation.input_tokens']).toBe(7)
		expect(a['gen_ai.usage.reasoning.output_tokens']).toBe(12)
		// Existing names are untouched.
		expect(a['namzu.cache.read_tokens']).toBe(20)
		expect(a['namzu.cache.write_tokens']).toBe(7)
	})

	it('does not state a cache count nobody reported', async () => {
		await run([{ text: REPLY }])
		const a = one('chat ').attributes
		expect(a).not.toHaveProperty('gen_ai.usage.cache_read.input_tokens')
		expect(a).not.toHaveProperty('gen_ai.usage.cache_creation.input_tokens')
		expect(a).not.toHaveProperty('gen_ai.usage.reasoning.output_tokens')
	})

	it('names the class of a failed call in error.type', async () => {
		await run([{ error: { message: 'rate limited', status: 429 } }])
		const failed = named('chat ').filter((s) => s.attributes['error.type'] !== undefined)
		expect(failed).toHaveLength(1)
		expect(failed[0]?.attributes['error.type']).toBe('ProviderError')
		for (const s of failed) {
			expect(typeof s.attributes['error.type']).toBe('string')
			expect(s.attributes['error.type']).not.toBe('')
			expect(s.status.code).toBe(2)
		}
		// Low cardinality: a class, not the message.
		expect(failed[0]?.attributes['error.type']).not.toContain('rate limited')
	})
})

describe('a tool call', () => {
	it('carries the convention names, with their types and values', async () => {
		await run(TOOL_TURNS)
		const a = one('namzu.tool.execute lookup').attributes
		expect(a['gen_ai.operation.name']).toBe('execute_tool')
		expect(a['gen_ai.tool.name']).toBe('lookup')
		expect(a['gen_ai.tool.call.id']).toBe('call_1')
		expect(a['gen_ai.tool.type']).toBe('function')
		expect(a).not.toHaveProperty('error.type')
		// Names and kinds of the kernel's span are unchanged.
		expect(one('namzu.tool.execute lookup').name).toBe('namzu.tool.execute lookup')
	})

	it('names the exception class of a tool that threw', async () => {
		await run(TOOL_TURNS, { throwInTool: true })
		const a = one('namzu.tool.execute lookup').attributes
		expect(a['error.type']).toBe('RangeError')
		expect(a['namzu.tool.success']).toBe(false)
	})

	it('names a call the kernel refused permission_denied', async () => {
		const manager = new ToolManager({
			toolsets: [
				toolset('test', [
					{
						name: 'lookup',
						description: 'looks something up',
						inputSchema: z.object({}),
						execute: async () => ({ success: true, output: 'x' }),
					} as never,
				]),
			],
			messages: () => [],
		})
		const result = await manager.execute('lookup', {}, {
			sessionId: generateSessionId(),
			turnId: generateTurnId(),
			workingDirectory: tmpdir(),
			abortSignal: new AbortController().signal,
			env: {},
			log: () => {},
			allowedTools: ['something_else'],
			toolUseId: 'call_denied',
		} as never)
		expect(result.success).toBe(false)
		const a = one('namzu.tool.execute lookup').attributes
		expect(a['gen_ai.operation.name']).toBe('execute_tool')
		expect(a['error.type']).toBe('permission_denied')
		expect(a['gen_ai.tool.call.id']).toBe('call_denied')
	})
})

describe('an agent run and a sub-agent run', () => {
	it('carries the operation, the agent and the conversation', async () => {
		await run([{ text: REPLY }], { providerId: 'openai', agentName: 'Planner' })
		const turn = one('namzu.agent.turn Planner')
		const a = turn.attributes
		expect(a['gen_ai.operation.name']).toBe('invoke_agent')
		expect(a['gen_ai.provider.name']).toBe('openai')
		expect(a['gen_ai.agent.name']).toBe('Planner')
		expect(a['gen_ai.agent.id']).toBe('agent_genai')
		expect(typeof a['gen_ai.conversation.id']).toBe('string')
		expect(a['gen_ai.request.model']).toBe('mock-model')
		expect(typeof a['gen_ai.usage.input_tokens']).toBe('number')
		// The kernel's span name is kept, not renamed to `invoke_agent Planner`.
		expect(named('invoke_agent')).toHaveLength(0)
	})

	it('a sub-agent is a second agent run under the caller, with the parent session named', async () => {
		const parent = getTracer().startSpan('namzu.tool.execute delegate')
		const parentSession = generateSessionId()
		await run([{ text: REPLY }], {
			agentName: 'Child',
			parentSpan: parent,
			parentSessionId: parentSession,
		})
		parent.end()
		const child = one('namzu.agent.turn Child')
		expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
		expect(child.spanContext().traceId).toBe(parent.spanContext().traceId)
		expect(child.attributes['gen_ai.operation.name']).toBe('invoke_agent')
		expect(child.attributes['gen_ai.agent.name']).toBe('Child')
		expect(child.attributes['namzu.session.parent_id']).toBe(parentSession)
	})

	it('a failed run names the class of the failure', async () => {
		await run([{ error: { message: 'bad request', status: 400 } }])
		const turn = one('namzu.agent.turn ')
		expect(turn.attributes['namzu.turn.status']).toBe('error')
		expect(turn.attributes['error.type']).toBe('ProviderError')
		expect(turn.status.code).toBe(2)
	})
})

describe('content', () => {
	it('is not on any span, under any name, by default', async () => {
		await run(TOOL_TURNS)
		const content = [
			'gen_ai.input.messages',
			'gen_ai.output.messages',
			'gen_ai.system_instructions',
			'gen_ai.tool.definitions',
			'gen_ai.tool.call.arguments',
			'gen_ai.tool.call.result',
		]
		for (const s of finished()) {
			for (const name of content) expect(s.attributes).not.toHaveProperty(name)
			const text = JSON.stringify([s.attributes, s.events, s.name])
			for (const sentinel of [PROMPT, REPLY, TOOL_ARG, TOOL_RESULT]) {
				expect(text).not.toContain(sentinel)
			}
		}
	})
})

describe('the setting', () => {
	it('off: no new name, no schema URL, and every existing name stays', async () => {
		const withNames = async () => {
			exporter.reset()
			await run(TOOL_TURNS, { providerId: 'anthropic' })
			return finished()
		}
		const on = await withNames()
		await getTelemetry()?.shutdown()
		trace.disable()
		await register(false)
		const off = await withNames()

		const added = [
			'gen_ai.provider.name',
			'gen_ai.request.stream',
			'gen_ai.usage.cache_read.input_tokens',
			'gen_ai.usage.cache_creation.input_tokens',
			'gen_ai.usage.reasoning.output_tokens',
			'error.type',
		]
		for (const s of off) {
			expect(s.instrumentationScope.schemaUrl).toBeUndefined()
			for (const name of added) expect(s.attributes).not.toHaveProperty(name)
		}
		expect(off.some((s) => s.attributes['gen_ai.operation.name'] === 'invoke_agent')).toBe(false)
		expect(off.some((s) => s.attributes['gen_ai.operation.name'] === 'execute_tool')).toBe(false)

		// Off is on minus the additions: nothing else moved.
		const strip = (spans: ReadableSpan[]) =>
			spans
				.map((s) => ({
					name: s.name,
					keys: Object.keys(s.attributes)
						.filter(
							(k) =>
								!added.includes(k) &&
								!(k === 'gen_ai.operation.name' && s.attributes[k] !== 'chat'),
						)
						.sort(),
				}))
				.sort((x, y) => x.name.localeCompare(y.name))
		expect(strip(off)).toEqual(strip(on))
	})

	it('is on by default and adds at most a handful of attributes per span', async () => {
		await run(
			[
				{
					toolCalls: [{ name: 'lookup', args: {}, id: 'c' }],
					usage: { cachedTokens: 5, cacheWriteTokens: 5, reasoningTokens: 5 },
				},
				{ text: REPLY },
			],
			{ providerId: 'anthropic', throwInTool: true },
		)
		const countAdded = (s: ReadableSpan) =>
			Object.keys(s.attributes).filter((k) =>
				[
					'gen_ai.provider.name',
					'gen_ai.request.stream',
					'gen_ai.usage.cache_read.input_tokens',
					'gen_ai.usage.cache_creation.input_tokens',
					'gen_ai.usage.reasoning.output_tokens',
					'error.type',
					'gen_ai.operation.name',
				].includes(k),
			).length
		const chat = named('chat ').map(countAdded)
		const tool = named('namzu.tool.execute ').map(countAdded)
		const turn = named('namzu.agent.turn ').map(countAdded)
		// operation.name already existed on the model call, so it is not an addition there.
		expect(Math.max(...chat) - 1).toBeLessThanOrEqual(5)
		expect(Math.max(...tool)).toBeLessThanOrEqual(2)
		expect(Math.max(...turn)).toBeLessThanOrEqual(3)
	})
})

describe('the table', () => {
	it('fails when an attribute name is emitted that the pinned list does not hold', async () => {
		await run(TOOL_TURNS, { providerId: 'anthropic', throwInTool: true })
		await run([{ error: { message: 'x', status: 429 } }], { providerId: 'openai' })
		const allowed = new Set([...GENAI_SEMCONV_ATTRIBUTES, ...GENAI_NON_CONVENTION_NAMES])
		const seen = new Set<string>()
		for (const s of finished()) {
			for (const k of Object.keys(s.attributes)) {
				if (k.startsWith('gen_ai.') || k === 'error.type') seen.add(k)
			}
		}
		expect(seen.size).toBeGreaterThan(10)
		const unknown = [...seen].filter((k) => !allowed.has(k))
		expect(unknown).toEqual([])
	})

	it('holds only names that exist in the pinned version, and the one name we keep beyond it', () => {
		// The list as it stands in 1.41.1's registry, written out here so a name
		// added to the SDK list without being found in the pinned text fails.
		const registry141 = [
			'gen_ai.operation.name',
			'gen_ai.provider.name',
			'error.type',
			'gen_ai.conversation.id',
			'gen_ai.agent.name',
			'gen_ai.agent.id',
			'gen_ai.request.model',
			'gen_ai.request.stream',
			'gen_ai.request.temperature',
			'gen_ai.request.max_tokens',
			'gen_ai.response.model',
			'gen_ai.response.id',
			'gen_ai.response.finish_reasons',
			'gen_ai.usage.input_tokens',
			'gen_ai.usage.output_tokens',
			'gen_ai.usage.cache_read.input_tokens',
			'gen_ai.usage.cache_creation.input_tokens',
			'gen_ai.usage.reasoning.output_tokens',
			'gen_ai.tool.name',
			'gen_ai.tool.call.id',
			'gen_ai.tool.type',
		]
		expect([...GENAI_SEMCONV_ATTRIBUTES].sort()).toEqual([...registry141].sort())
		expect([...GENAI_NON_CONVENTION_NAMES]).toEqual(['gen_ai.system'])
	})
})
