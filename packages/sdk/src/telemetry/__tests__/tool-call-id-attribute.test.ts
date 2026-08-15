import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { GENAI } from '../../constants/telemetry/index.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import { drainQuery } from '../../runtime/query/index.js'
import type { RunId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type { ToolContext } from '../../types/tool/index.js'

/**
 * Two halves of one defect, both of which read as working code.
 *
 * The constant was spelled `gen_ai.tool.call_id` while the registry and its
 * two neighbours in the same object use `gen_ai.tool.name` / `.type` — one
 * underscore where a dot belongs. A span attribute is a free-form key, so
 * the wrong one raises nothing anywhere; it just means a consumer grouping
 * by the conventional name finds an empty result and reads it as "no tool
 * calls" rather than "wrong key".
 *
 * The half that a spelling fix alone would have left in place: nothing set
 * the attribute. The constant was exported through the SDK root barrel and
 * through `@namzu/telemetry/attributes` with zero writers, so no namzu span
 * carried the correlation under EITHER spelling, and renaming it on its own
 * would have changed a string no trace contained.
 */

interface Recorded {
	name: string
	attributes: Record<string, unknown>
}

const spans: Recorded[] = []

// A function declaration, not a const: `vi.mock` is hoisted above the
// imports, so anything the factory closes over has to be hoisted too.
function record(name: string) {
	const rec: Recorded = { name, attributes: {} }
	spans.push(rec)
	return {
		setAttributes: (a: Record<string, unknown>) => Object.assign(rec.attributes, a),
		setAttribute: (k: string, v: unknown) => {
			rec.attributes[k] = v
		},
		setStatus: () => undefined,
		recordException: () => undefined,
		addEvent: () => undefined,
		end: () => undefined,
		spanContext: () => ({ traceId: 't', spanId: 's', traceFlags: 1 }),
		isRecording: () => true,
		updateName: () => undefined,
	}
}

vi.mock('../runtime-accessors.js', () => ({
	// The module has more than one export, and a factory mock replaces ALL of
	// them — so omitting this one does not fall through to the real
	// implementation, it makes the import undefined. `recordAudit` reads the
	// active span to stamp an audit event, so a partial mock here surfaces as
	// a run failure in a file that is not about spans at all.
	getActiveSpanContext: () => undefined,
	getTracer: () => ({
		startSpan: (name: string) => record(name),
		startActiveSpan: (name: string, _o: unknown, _c: unknown, fn: (s: unknown) => unknown) =>
			fn(record(name)),
	}),
	getMeter: () => ({
		createCounter: () => ({ add: () => undefined }),
		createHistogram: () => ({ record: () => undefined }),
	}),
}))

let workdirs: string[] = []

beforeEach(() => {
	spans.length = 0
})

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs = []
})

const toolSpans = () => spans.filter((s) => s.name.startsWith('namzu.tool.execute '))

function registerPing(): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register({
		name: 'ping',
		description: 'answers',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'pong' }),
	})
	return tools
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		runId: 'run_call_id' as RunId,
		workingDirectory: tmpdir(),
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...overrides,
	}
}

describe('the tool-call id attribute is spelled the way the registry spells it', () => {
	it('uses a dot, matching its two neighbours', () => {
		// The literal, deliberately. Asserting `attrs[GENAI.TOOL_CALL_ID]`
		// below and nothing else would pass against any spelling at all,
		// including the one this fixes — the emitter and the reader would
		// simply agree on the wrong string.
		expect(GENAI.TOOL_CALL_ID).toBe('gen_ai.tool.call.id')
		expect(GENAI.TOOL_NAME).toBe('gen_ai.tool.name')
		expect(GENAI.TOOL_TYPE).toBe('gen_ai.tool.type')
	})
})

describe('the tool span carries the id of the call it is about', () => {
	it('stamps it when the executor supplies one', async () => {
		await registerPing().execute('ping', {}, context({ toolUseId: 'toolu_direct' }))

		expect(toolSpans()).toHaveLength(1)
		expect(toolSpans()[0]?.attributes['gen_ai.tool.call.id']).toBe('toolu_direct')
	})

	it('omits the key entirely when there is no call to correlate to', async () => {
		// `toolUseId` is optional — a host may call a tool directly, outside
		// a run. Setting the attribute to `undefined` would reach the
		// exporter as a present key with no value, which is worse than an
		// absent one: a query for "spans missing the id" would not find it.
		await registerPing().execute('ping', {}, context())

		expect(toolSpans()).toHaveLength(1)
		expect(toolSpans()[0]?.attributes).not.toHaveProperty('gen_ai.tool.call.id')
	})

	it('carries the id a real run produced, not only one a test handed in', async () => {
		// Reachability is its own property. The two cases above prove the
		// emit site reads `ToolContext.toolUseId`; neither proves the run
		// loop puts anything there, and the field's own docstring says not
		// every executor path provides it. This drives the whole query path
		// so the id on the span is one the provider actually emitted.
		const dir = await mkdtemp(join(tmpdir(), 'namzu-callid-'))
		workdirs.push(dir)

		await drainQuery({
			provider: new MockLLMProvider({
				// The second turn settles the run. Without it the mock replays
				// its LAST turn for every iteration past the end of the script,
				// so the tool is called once per iteration and the span count
				// below measures `maxIterations` rather than the script — a
				// fixture bug that reads as a duplicate span, which is the
				// reading that got a sibling assertion relaxed once already.
				turns: [
					{ toolCalls: [{ id: 'toolu_from_the_wire', name: 'ping', args: {} }] },
					{ text: 'done' },
				],
			}),
			tools: registerPing(),
			runConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 2,
				maxResponseTokens: 256,
			},
			agentId: 'agent_callid',
			agentName: 'Call Id Agent',
			workingDirectory: dir,
			sessionId: 'ses_callid',
			topicId: 'top_callid',
			projectId: 'prj_callid',
			tenantId: 'tnt_callid',
			messages: [createUserMessage('go')],
		})

		expect(toolSpans()).toHaveLength(1)
		expect(toolSpans()[0]?.attributes['gen_ai.tool.call.id']).toBe('toolu_from_the_wire')
		expect(toolSpans()[0]?.attributes['gen_ai.tool.name']).toBe('ping')
	})
})
