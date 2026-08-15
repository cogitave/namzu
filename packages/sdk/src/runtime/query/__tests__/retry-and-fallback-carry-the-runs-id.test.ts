/**
 * Every retry warning and every fallback swap carries `namzu.run.id`.
 *
 * Before LOG-07, `runtime/query/index.ts` built `withProviderRetry` and
 * `withProviderFallback` off a bare `getRootLogger()` — the two highest-
 * frequency uncorrelated log sites in the kernel. An operator staring at a
 * "Provider call failed — retrying" line had no way to say which run it was
 * retrying FOR; a "Provider chain: falling over" line could not be joined
 * back to the run record it changed. `one-logger-reaches-retry-and-
 * fallback.test.ts` proves the wiring is a single shared object; this file
 * proves what that object actually WRITES. `docs/conventions/
 * one-site-is-not-every-site.md` is why the assertion below is a loop over
 * every captured record, never a `toContain` on the first one.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { NAMZU } from '../../../constants/telemetry/index.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import type { AgentRunConfig } from '../../../types/run/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { type LogRecord, type LogSink, createLogger } from '../../../utils/log/index.js'
import { __resetProcessSinkForTests, installProcessSink } from '../../../utils/log/process-sink.js'
import { drainQuery } from '../index.js'

/** A provider that always fails the way `status` says. */
function failing(id: string, status: number): LLMProvider & { calls: number } {
	let calls = 0
	return {
		id,
		name: id,
		// eslint-disable-next-line require-yield
		chatStream: (_params: ChatCompletionParams): AsyncIterable<StreamChunk> => {
			calls++
			return (async function* () {
				throw Object.assign(new Error(`HTTP ${status}`), { status })
				// biome-ignore lint/correctness/noUnreachable: the generator must be one
				yield { id: '', delta: {} } as StreamChunk
			})()
		},
		get calls() {
			return calls
		},
	} as unknown as LLMProvider & { calls: number }
}

function baseRunConfig(): AgentRunConfig {
	return {
		model: 'primary-model',
		timeoutMs: 5_000,
		tokenBudget: 100_000,
		maxIterations: 1,
		maxResponseTokens: 256,
	}
}

function baseParams(workingDirectory: string) {
	return {
		tools: new ToolRegistry(),
		runConfig: baseRunConfig(),
		agentId: 'agent_correlated',
		agentName: 'Correlated Agent',
		workingDirectory,
		sessionId: 'ses_correlated' as SessionId,
		threadId: 'thd_correlated' as ThreadId,
		projectId: 'prj_correlated' as ProjectId,
		tenantId: 'tnt_correlated' as TenantId,
		retry: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1 },
	}
}

/**
 * Records logged by `withProviderRetry` or `withProviderFallback`, and only
 * those — their message text ('Provider call failed…', 'Provider chain:
 * …') is the only thing distinguishing their records from the rest of a
 * run's boot and lifecycle output in the same capturing sink.
 */
function wrapperRecords(records: LogRecord[]): LogRecord[] {
	return records.filter(
		(r) => r.body.startsWith('Provider call failed') || r.body.startsWith('Provider chain:'),
	)
}

describe('retry and fallback records are correlated to the run that produced them', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
		__resetProcessSinkForTests()
	})

	async function mkWorkdir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-retry-correlation-'))
		workdirs.push(dir)
		return dir
	}

	it("every retry warning and every fallback swap carries this run's namzu.run.id", async () => {
		const primary = failing('primary', 429)
		const fallback = new MockLLMProvider({ turns: [{ text: 'the fallback answered' }] })

		const records: LogRecord[] = []
		const sink: LogSink = { emit: (record) => records.push(record) }
		installProcessSink(sink, 'debug', { replace: true })

		const run = await drainQuery({
			...baseParams(await mkWorkdir()),
			provider: primary,
			fallbackProviders: [{ provider: fallback, model: 'fallback-model' }],
			messages: [createUserMessage('hello')],
		})

		expect(run.status).toBe('completed')

		const wrapperLogs = wrapperRecords(records)
		// If this is empty the loop below is vacuously true and proves
		// nothing — pin that the scenario actually produced the records it
		// claims to before trusting the loop that reads them.
		expect(wrapperLogs.length).toBeGreaterThan(0)
		for (const record of wrapperLogs) {
			expect(record.attributes[NAMZU.RUN_ID]).toBe(run.id)
		}
	})

	it('a host-supplied runConfig.logger is what buildLogger derives from, not the process root', async () => {
		const primary = failing('primary', 429)
		const fallback = new MockLLMProvider({ turns: [{ text: 'the fallback answered' }] })

		// Installed as the process default so a call that fell through to
		// `getRootLogger()` would still be captured — the marker check below
		// needs a place a wrongly-sourced record COULD land to be meaningful.
		const rootRecords: LogRecord[] = []
		const rootSink: LogSink = { emit: (record) => rootRecords.push(record) }
		installProcessSink(rootSink, 'debug', { replace: true })

		const markerRecords: LogRecord[] = []
		const markerSink: LogSink = { emit: (record) => markerRecords.push(record) }
		const marker = createLogger({
			sink: markerSink,
			level: { current: 'debug' },
			resource: { 'service.name': 'namzu' },
			scope: 'namzu',
		})

		const params = baseParams(await mkWorkdir())

		const run = await drainQuery({
			...params,
			runConfig: { ...params.runConfig, logger: marker },
			provider: primary,
			fallbackProviders: [{ provider: fallback, model: 'fallback-model' }],
			messages: [createUserMessage('hello')],
		})

		expect(run.status).toBe('completed')

		const wrapperLogs = wrapperRecords(markerRecords)
		expect(wrapperLogs.length).toBeGreaterThan(0)
		for (const record of wrapperLogs) {
			expect(record.attributes[NAMZU.RUN_ID]).toBe(run.id)
		}
		expect(wrapperRecords(rootRecords)).toHaveLength(0)
	})
})
