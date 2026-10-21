import { afterEach, describe, expect, it, vi } from 'vitest'

import { BackgroundJobRegistry, bindOwner } from '../../../runtime/jobs/registry.js'
import type { SandboxId, SessionId, TurnId } from '../../../types/ids/index.js'
import type { Sandbox } from '../../../types/sandbox/index.js'
import type { BackgroundJobRegistryRef, ToolContext } from '../../../types/tool/index.js'
import { DISABLE_BACKGROUND_TASKS_ENV } from '../bash.js'
import { JobTool } from '../job.js'
import { MONITOR_CANNOT_DETACH, MonitorTool, getMonitorTools } from '../monitor.js'

afterEach(() => {
	vi.unstubAllEnvs()
})

function context(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId,
		turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as TurnId,
		workingDirectory: process.cwd(),
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...overrides,
	}
}

/** A registry ref that records the call and never starts a process. */
function fakeJobs(cap = 1_800_000) {
	const startMonitor = vi.fn(
		(params: { command: string; description: string; timeoutMs: number }) => ({
			job: { id: 'b00000001', status: 'running' },
			timeoutMs: Math.min(params.timeoutMs, cap),
		}),
	)
	const jobs = {
		start: vi.fn(),
		startMonitor,
		awaitStarted: vi.fn(async () => ({})),
		get: (): never => {
			throw new Error('not used')
		},
		read: (): never => {
			throw new Error('not used')
		},
		kill: async (): Promise<never> => {
			throw new Error('not used')
		},
		list: () => [],
	} as unknown as BackgroundJobRegistryRef
	return { jobs, startMonitor }
}

function parse(input: Record<string, unknown>) {
	return MonitorTool.inputSchema.parse(input)
}

describe('the monitor tool’s input', () => {
	it('defaults the timeout to five minutes', () => {
		expect(parse({ description: 'd', command: 'tail -f log' }).timeout_ms).toBe(300_000)
	})

	it('accepts the schema’s own range and refuses what is outside it', () => {
		expect(parse({ description: 'd', command: 'c', timeout_ms: 1000 }).timeout_ms).toBe(1000)
		expect(parse({ description: 'd', command: 'c', timeout_ms: 3_600_000 }).timeout_ms).toBe(
			3_600_000,
		)
		expect(() => parse({ description: 'd', command: 'c', timeout_ms: 999 })).toThrow()
		expect(() => parse({ description: 'd', command: 'c', timeout_ms: 3_600_001 })).toThrow()
		expect(() => parse({ description: 'd', command: 'c', timeout_ms: 1.5 })).toThrow()
	})

	it('requires a description of one to two hundred characters and a command', () => {
		expect(() => parse({ description: '', command: 'c' })).toThrow()
		expect(() => parse({ description: 'x'.repeat(201), command: 'c' })).toThrow()
		expect(() => parse({ description: 'd', command: '' })).toThrow()
	})
})

describe('the monitor tool’s permissions are bash’s, without the way out', () => {
	it('reads the command like bash, needs shell execution, and is never read-only', () => {
		expect(MonitorTool.commandArgument).toBe('command')
		expect(MonitorTool.permissions).toEqual(['shell_execute', 'network_access'])
		const input = { description: 'd', command: 'tail -f app.log', timeout_ms: 1000 }
		expect(MonitorTool.isReadOnly?.(input)).toBe(false)
		expect(MonitorTool.isConcurrencySafe?.(input)).toBe(false)
		expect(MonitorTool.sandboxEscapeArgument).toBeUndefined()
	})

	it('is destructive for the lines bash calls dangerous', () => {
		expect(
			MonitorTool.isDestructive?.({ description: 'd', command: 'rm -rf /', timeout_ms: 1000 }),
		).toBe(true)
		expect(
			MonitorTool.isDestructive?.({
				description: 'd',
				command: 'tail -f app.log',
				timeout_ms: 1000,
			}),
		).toBe(false)
	})

	it('is offered by getMonitorTools and by nothing else', () => {
		expect(getMonitorTools()).toEqual([MonitorTool])
	})
})

describe('starting a monitor', () => {
	it('starts the watch, waits for the process to exist, and tells the model how it is stopped', async () => {
		const { jobs, startMonitor } = fakeJobs()
		const result = await MonitorTool.execute(
			parse({ description: 'errors in log', command: 'tail -f app.log', timeout_ms: 90_000 }),
			context({ backgroundJobs: jobs }),
		)

		expect(startMonitor).toHaveBeenCalledWith({
			command: 'tail -f app.log',
			description: 'errors in log',
			timeoutMs: 90_000,
			workingDirectory: process.cwd(),
		})
		expect(result.success).toBe(true)
		expect(result.output).toBe(
			'Monitor started (job b00000001, expires in 90s unless the command ends first; you get one notice at expiry — start it again if you still need the watch). Each line the command prints to stdout reaches you as an event while you keep working; do not poll or sleep. Stop it with job {"action":"kill","id":"b00000001"}. An event may arrive while you are waiting for the user — it is not their reply.',
		)
		expect(result.data).toEqual({ jobId: 'b00000001', monitor: true, timeoutMs: 90_000 })
		expect(result.facts).toEqual({ kind: 'command', command: 'tail -f app.log', background: true })
	})

	it('reports the clamped timeout, not the requested one', async () => {
		const { jobs } = fakeJobs(600_000)
		const result = await MonitorTool.execute(
			parse({ description: 'd', command: 'c', timeout_ms: 3_600_000 }),
			context({ backgroundJobs: jobs }),
		)
		expect(result.data).toMatchObject({ timeoutMs: 600_000 })
		expect(result.output).toContain('expires in 10m')
	})

	it('clamps through a real binding to the host’s ceiling', async () => {
		const registry = new BackgroundJobRegistry()
		const bound = bindOwner(registry, 'turn-1', { monitorTimeoutCapMs: 900_000 })
		try {
			const result = await MonitorTool.execute(
				parse({ description: 'd', command: 'sleep 30', timeout_ms: 3_000_000 }),
				context({ backgroundJobs: bound }),
			)
			expect(result.success).toBe(true)
			expect(result.data).toMatchObject({ monitor: true, timeoutMs: 900_000 })
			expect(result.output).toContain('expires in 15m')
		} finally {
			await registry.killOwner('turn-1')
		}
	})

	it('says why when the process could not start', async () => {
		const { jobs } = fakeJobs()
		;(jobs.awaitStarted as ReturnType<typeof vi.fn>).mockResolvedValue({ error: 'no such shell' })
		const result = await MonitorTool.execute(
			parse({ description: 'd', command: 'c' }),
			context({ backgroundJobs: jobs }),
		)
		expect(result).toMatchObject({
			success: false,
			error: 'no such shell (monitor b00000001 did not run).',
		})
	})

	it('relays the per-owner cap instead of inventing a failure', async () => {
		const { jobs, startMonitor } = fakeJobs()
		startMonitor.mockImplementation(() => {
			throw new Error(
				'Owner o already has 8 running background jobs; kill one before starting another.',
			)
		})
		const result = await MonitorTool.execute(
			parse({ description: 'd', command: 'c' }),
			context({ backgroundJobs: jobs }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('already has 8 running background jobs')
	})
})

describe('the monitor tool’s refusals', () => {
	it('refuses a host with no registry', async () => {
		const result = await MonitorTool.execute(parse({ description: 'd', command: 'c' }), context())
		expect(result.success).toBe(false)
		expect(result.error).toContain('no background job registry')
	})

	it('refuses a host that cannot deliver events', async () => {
		const { jobs } = fakeJobs()
		const { startMonitor: _removed, ...withoutMonitor } = jobs
		const result = await MonitorTool.execute(
			parse({ description: 'd', command: 'c' }),
			context({ backgroundJobs: withoutMonitor as BackgroundJobRegistryRef }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('cannot deliver monitor events')
	})

	it('refuses when background tasks are switched off', async () => {
		vi.stubEnv(DISABLE_BACKGROUND_TASKS_ENV, '1')
		const { jobs, startMonitor } = fakeJobs()
		const result = await MonitorTool.execute(
			parse({ description: 'd', command: 'c' }),
			context({ backgroundJobs: jobs }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain(DISABLE_BACKGROUND_TASKS_ENV)
		expect(startMonitor).not.toHaveBeenCalled()
	})

	it('refuses a dangerous command', async () => {
		const { jobs, startMonitor } = fakeJobs()
		const result = await MonitorTool.execute(
			parse({ description: 'd', command: 'rm -rf /' }),
			context({ backgroundJobs: jobs }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('Dangerous command blocked')
		expect(startMonitor).not.toHaveBeenCalled()
	})

	it('refuses a sandbox that cannot start a detached process, and never runs on the host instead', async () => {
		const { jobs, startMonitor } = fakeJobs()
		const sandbox: Sandbox = {
			id: '51281012-1dd1-444d-98b8-487422669dff' as SandboxId,
			status: 'ready',
			rootDir: '/workspace',
			environment: 'basic',
			exec: vi.fn(),
			writeFile: vi.fn(),
			readFile: vi.fn(),
			listFiles: vi.fn(),
			destroy: vi.fn(),
		} as unknown as Sandbox
		const result = await MonitorTool.execute(
			parse({ description: 'd', command: 'c' }),
			context({ backgroundJobs: jobs, sandbox }),
		)
		expect(result).toEqual({ success: false, output: '', error: MONITOR_CANNOT_DETACH })
		expect(startMonitor).not.toHaveBeenCalled()
		expect(sandbox.exec).not.toHaveBeenCalled()
	})
})

describe('how a call to the monitor tool reads in a transcript', () => {
	it('is labelled by what it watches, with the command as a fact', () => {
		const presented = MonitorTool.presentCall?.({
			description: 'errors in deploy log',
			command: 'tail -f deploy.log',
			timeout_ms: 300_000,
		})
		expect(presented).toEqual({
			kind: 'generic',
			label: 'Monitor · errors in deploy log',
			facts: { kind: 'command', command: 'tail -f deploy.log', background: true },
		})
	})
})

describe('the job tool and a monitor', () => {
	// A real `sleep`, started and killed through the real registry: the stop is
	// confirmed by the process's own exit, not by a clock.
	it('lists a monitor by what it watches, and a kill is recorded as a stop', async () => {
		const registry = new BackgroundJobRegistry()
		const bound = bindOwner(registry, 'turn-1')
		try {
			const started = await MonitorTool.execute(
				parse({ description: 'nightly build', command: 'sleep 30' }),
				context({ backgroundJobs: bound }),
			)
			const jobId = (started.data as { jobId: string }).jobId

			const listed = await JobTool.execute({ action: 'list' }, context({ backgroundJobs: bound }))
			expect(listed.output).toBe(`${jobId}  running   monitor · nightly build`)

			const killed = await JobTool.execute(
				{ action: 'kill', id: jobId },
				context({ backgroundJobs: bound }),
			)
			expect(killed.output).toBe(`Job ${jobId} is killed.`)
			expect(registry.get(jobId).stopReason).toBe('stopped')
		} finally {
			await registry.killOwner('turn-1')
		}
	}, 30_000)
})
