/**
 * The run's logger is built ONCE, not once per site that happened to need
 * one.
 *
 * Before this, `runtime/query/index.ts` read `getRootLogger()` three
 * separate times inside `query()` — once inline for the boot-time
 * migration, once for `withProviderRetry`, once for `withProviderFallback`
 * — plus a fourth read buried inside `RunContextFactory.build` for the
 * run's own child logger. Four calls that happened to describe the same
 * run and carried four separate chances to disagree, on the highest-
 * frequency uncorrelated log path in the kernel. `RunContextFactory
 * .buildLogger` exists so there is exactly one call, and this file is the
 * falsifiable half of that claim: it does not read log CONTENT (see
 * `retry-and-fallback-carry-the-runs-id.test.ts` for that) — it reads
 * IDENTITY, the property a content assertion cannot see. `withProviderRetry`,
 * `withProviderFallback` and `RunContextFactory.build` are three
 * independent consumers; each getting a logger that logs the same fields
 * is not the same guarantee as each getting the SAME object, and only the
 * second one is what LOG-07's acceptance criteria actually asked for.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import type { Logger } from '../../../utils/logger.js'

/** Every `log` a `withProviderRetry` construction received — one per chain member. */
const retryLogs: (Logger | undefined)[] = []
/** Every `log` a `withProviderFallback` construction received — one per query(). */
const fallbackLogs: (Logger | undefined)[] = []
/** Every `config.log` a `RunContextFactory.build` call received — one per query(). */
const buildLogs: (Logger | undefined)[] = []
/** How many times `RunContextFactory.buildLogger` actually ran. */
let buildLoggerCalls = 0

vi.mock('../../../provider/retry.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../provider/retry.js')>()
	return {
		...actual,
		withProviderRetry: (
			...args: Parameters<typeof actual.withProviderRetry>
		): ReturnType<typeof actual.withProviderRetry> => {
			retryLogs.push(args[1]?.log)
			return actual.withProviderRetry(...args)
		},
	}
})

vi.mock('../../../provider/fallback.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../provider/fallback.js')>()
	return {
		...actual,
		withProviderFallback: (
			...args: Parameters<typeof actual.withProviderFallback>
		): ReturnType<typeof actual.withProviderFallback> => {
			fallbackLogs.push(args[1]?.log)
			return actual.withProviderFallback(...args)
		},
	}
})

vi.mock('../context.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../context.js')>()
	return {
		...actual,
		RunContextFactory: {
			ensureMigrated: actual.RunContextFactory.ensureMigrated,
			buildLogger: (
				...args: Parameters<typeof actual.RunContextFactory.buildLogger>
			): ReturnType<typeof actual.RunContextFactory.buildLogger> => {
				buildLoggerCalls++
				return actual.RunContextFactory.buildLogger(...args)
			},
			build: (
				...args: Parameters<typeof actual.RunContextFactory.build>
			): ReturnType<typeof actual.RunContextFactory.build> => {
				buildLogs.push(args[0].log)
				return actual.RunContextFactory.build(...args)
			},
		},
	}
})

const { drainQuery } = await import('../index.js')

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

describe('the run logger reaches withProviderRetry, withProviderFallback and build as one object', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
		retryLogs.length = 0
		fallbackLogs.length = 0
		buildLogs.length = 0
		buildLoggerCalls = 0
	})

	async function mkWorkdir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-shared-logger-'))
		workdirs.push(dir)
		return dir
	}

	it('buildLogger runs exactly once per query() and every consumer gets the identical reference', async () => {
		const primary = failing('primary', 429)
		const fallback = new MockLLMProvider({ turns: [{ text: 'the fallback answered' }] })

		const run = await drainQuery({
			provider: primary,
			tools: new ToolRegistry(),
			fallbackProviders: [{ provider: fallback, model: 'fallback-model' }],
			retry: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1 },
			runConfig: {
				model: 'primary-model',
				timeoutMs: 5_000,
				tokenBudget: 100_000,
				maxIterations: 1,
				maxResponseTokens: 256,
			},
			agentId: 'agent_shared_logger',
			agentName: 'Shared Logger Agent',
			workingDirectory: await mkWorkdir(),
			sessionId: 'ses_shared' as SessionId,
			topicId: 'top_shared' as ThreadId,
			projectId: 'prj_shared' as ProjectId,
			tenantId: 'tnt_shared' as TenantId,
			messages: [createUserMessage('hello')],
		})

		expect(run.status).toBe('completed')

		expect(buildLoggerCalls).toBe(1)
		// One `withProviderRetry` construction per chain member (primary,
		// fallback) — both wrapped with the SAME log, not a fresh
		// `getRootLogger()` read apiece.
		expect(retryLogs.length).toBe(2)
		expect(fallbackLogs.length).toBe(1)
		expect(buildLogs.length).toBe(1)

		const log = buildLogs[0]
		expect(log).toBeDefined()
		for (const retryLog of retryLogs) {
			expect(retryLog).toBe(log)
		}
		expect(fallbackLogs[0]).toBe(log)
	})
})
