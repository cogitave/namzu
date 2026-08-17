import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
// Imported at module scope on purpose, and must stay there.
//
// This was `await import(...)` repeated inside all five test bodies. That
// billed the tool-registry module graph to whichever test happened to run
// first, out of that test's own 5000ms deadline — and because every body
// re-entered the same pending import, a stall did not fail one test, it took
// the whole file down. At module scope the load happens during collection,
// which has no per-test deadline.
//
// `vi.mock` is hoisted above every import here, so the static form still
// receives the mocked `runtime-accessors`.
import { ToolRegistry } from '../../registry/tool/execute.js'

/**
 * A span that never ends is a trace that never closes, and the export is
 * incomplete for exactly the run that failed.
 *
 * Both sites had the same shape: an `end()` call at every exit the author
 * could see. The iteration loop had seventeen of them and the tool executor
 * three plus a `finally` that opened below them. That is a rule every future
 * edit has to remember, and it was already broken — anything throwing between
 * the span's creation and the `try` left it open, and a generator abandoned
 * by its consumer reached no exit at all.
 */

const ended: string[] = []
const started: string[] = []

function fakeSpan(name: string) {
	return {
		setAttributes: () => undefined,
		setAttribute: () => undefined,
		setStatus: () => undefined,
		recordException: () => undefined,
		addEvent: () => undefined,
		end: () => ended.push(name),
		spanContext: () => ({ traceId: 't', spanId: 's', traceFlags: 1 }),
		isRecording: () => true,
		updateName: () => undefined,
	}
}

vi.mock('../runtime-accessors.js', () => ({
	getTracer: () => ({
		startSpan: (name: string) => {
			started.push(name)
			return fakeSpan(name)
		},
		startActiveSpan: (
			name: string,
			_opts: unknown,
			_ctx: unknown,
			fn: (span: ReturnType<typeof fakeSpan>) => unknown,
		) => {
			started.push(name)
			return fn(fakeSpan(name))
		},
	}),
	getMeter: () => ({
		createCounter: () => ({ add: () => undefined }),
		createHistogram: () => ({ record: () => undefined }),
	}),
	// The module's third export, and this factory replaces the module WHOLE —
	// anything left out is not passed through, it is absent, and the first
	// caller gets "No X export is defined on the mock". `create-logger.ts`
	// resolves this on every emit to stamp `trace_id`/`span_id`. It went
	// unnoticed because the suite-wide setup file silenced logging to
	// `silent`, so no record ever reached the line that calls it; LOG-20
	// deleted that file (silence is now what a component with no logger does
	// on its own) and the missing export surfaced immediately.
	getActiveSpanContext: () => undefined,
}))

function toolContext() {
	return {
		runId: 'run_span',
		workingDirectory: '.',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => undefined,
	} as never
}

beforeEach(() => {
	started.length = 0
	ended.length = 0
})

afterEach(() => {
	vi.clearAllMocks()
})

describe('a tool span closes however the call leaves', () => {
	it('closes on the ordinary path', async () => {
		const tools = new ToolRegistry()
		tools.register({
			name: 'echo',
			description: 'echo',
			inputSchema: z.object({}),
			execute: async () => ({ success: true, output: 'ok' }),
		})

		await tools.execute('echo', {}, toolContext())

		expect(started).toHaveLength(1)
		expect(ended).toEqual(started)
	})

	it('closes when the tool throws', async () => {
		const tools = new ToolRegistry()
		tools.register({
			name: 'boom',
			description: 'boom',
			inputSchema: z.object({}),
			execute: async () => {
				throw new Error('kaboom')
			},
		})

		await tools.execute('boom', {}, toolContext())

		expect(ended).toEqual(started)
	})

	it('closes when input validation refuses the call', async () => {
		const tools = new ToolRegistry()
		tools.register({
			name: 'strict',
			description: 'strict',
			inputSchema: z.object({ required: z.string() }),
			execute: async () => ({ success: true, output: 'ok' }),
		})

		await tools.execute('strict', { wrong: 1 }, toolContext())

		expect(ended).toEqual(started)
	})

	it('closes when the tool is not active', async () => {
		const tools = new ToolRegistry()
		tools.register(
			{
				name: 'later',
				description: 'later',
				inputSchema: z.object({}),
				execute: async () => ({ success: true, output: 'ok' }),
			},
			'deferred',
		)

		await tools.execute('later', {}, toolContext())

		expect(ended).toEqual(started)
	})

	it('closes when the registry does not hold the name at all', async () => {
		const tools = new ToolRegistry()

		// `getOrThrow` sat OUTSIDE the try that owned the finally, so this
		// path — the one where the model invents a tool name — opened a span
		// and never closed it.
		await expect(tools.execute('nonexistent', {}, toolContext())).rejects.toThrow()

		expect(started).toHaveLength(1)
		expect(ended).toEqual(started)
	})
})
