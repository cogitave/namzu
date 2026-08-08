import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Context, type Span, type Tracer, trace } from '@opentelemetry/api'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * Every run started its OWN root trace, including a spawned sub-agent's.
 * A supervisor delegating to three children produced four disconnected
 * traces rather than one tree — the same defect that made a 20-turn run
 * appear as 21 roots before iterations were parented, except across the
 * spawn boundary, where the delegation structure is the thing you most
 * want to see.
 *
 * Captures what is handed to `startSpan` rather than pulling in an
 * exporter, matching the approach in `telemetry/__tests__` — the question
 * here is whether the parent is PASSED, and that is answerable at the call.
 */

const dirs: string[] = []

function fakeSpan(id: string): Span {
	const self: Span = {
		spanContext: () => ({ traceId: `trace-${id}`, spanId: id, traceFlags: 1 }),
		setAttribute: () => self,
		setAttributes: () => self,
		addEvent: () => self,
		setStatus: () => self,
		updateName: () => self,
		end: () => {},
		isRecording: () => true,
		recordException: () => {},
		addLink: () => self,
		addLinks: () => self,
	} as unknown as Span
	return self
}

/** Records the context each span was started with. */
function recordingTracer(): { tracer: Tracer; started: { name: string; parent?: Span }[] } {
	const started: { name: string; parent?: Span }[] = []
	const tracer = {
		startSpan: (name: string, _opts?: unknown, ctx?: Context) => {
			const parent = ctx ? trace.getSpan(ctx) : undefined
			started.push({ name, ...(parent ? { parent } : {}) })
			return fakeSpan(`span-${started.length}`)
		},
		startActiveSpan: (() => {
			throw new Error('startActiveSpan does not hold context across yield; not used here')
		}) as never,
	} as unknown as Tracer
	return { tracer, started }
}

afterEach(async () => {
	trace.disable()
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function runOnce(parentSpan?: Span) {
	const { tracer, started } = recordingTracer()
	trace.setGlobalTracerProvider({ getTracer: () => tracer } as never)

	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-trace-'))
	dirs.push(workingDirectory)

	await drainQuery({
		provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
		tools: new ToolRegistry(),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 10_000,
			tokenBudget: 100_000,
			maxIterations: 3,
			maxResponseTokens: 256,
		},
		agentId: 'agent_t',
		agentName: 'Traced',
		messages: [createUserMessage('go')],
		workingDirectory,
		sessionId: 'ses_t' as SessionId,
		threadId: 'thd_t' as ThreadId,
		projectId: 'prj_t' as ProjectId,
		tenantId: 'tnt_t' as TenantId,
		...(parentSpan ? { parentSpan } : {}),
	})

	return started
}

describe('a delegated run joins the trace it belongs to', () => {
	it('parents its root span to the supplied span', async () => {
		const caller = fakeSpan('delegating-tool')
		const started = await runOnce(caller)

		// The run span is the first thing the run starts.
		const runSpan = started[0]
		expect(runSpan).toBeDefined()
		expect(runSpan?.parent).toBe(caller)
	})

	it('a top-level run still starts its own root', async () => {
		// Absent a parent, a run IS the root. Forcing one would be wrong.
		const started = await runOnce()

		expect(started[0]).toBeDefined()
		expect(started[0]?.parent).toBeUndefined()
	})

	it('iterations still parent to the run, not to the caller', async () => {
		// The cross-run fix must not disturb the within-run hierarchy.
		const caller = fakeSpan('delegating-tool')
		const started = await runOnce(caller)

		expect(started.length).toBeGreaterThan(1)
		const iteration = started[1]
		expect(iteration?.parent).toBeDefined()
		expect(iteration?.parent).not.toBe(caller)
	})
})
