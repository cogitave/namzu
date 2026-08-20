import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SandboxId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import { RunCancelled } from '../../../types/run/cancel-cause.js'
import type { RunEvent } from '../../../types/run/index.js'
import type {
	Sandbox,
	SandboxCreateConfig,
	SandboxDestroyOptions,
	SandboxProvider,
} from '../../../types/sandbox/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

const workdirs: string[] = []

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs.length = 0
})

function deferred<T>(): {
	readonly promise: Promise<T>
	readonly resolve: (value: T) => void
	readonly reject: (reason: unknown) => void
} {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

function boundary(destroy: (options?: SandboxDestroyOptions) => Promise<void>): Sandbox {
	return {
		id: 'sbx_lifecycle' as SandboxId,
		status: 'ready',
		rootDir: '/workspace',
		environment: 'basic',
		exec: async () => ({
			stdout: '',
			stderr: '',
			exitCode: 0,
			durationMs: 0,
			timedOut: false,
		}),
		writeFile: async () => {},
		readFile: async () => Buffer.alloc(0),
		listFiles: async () => [],
		destroy,
	}
}

async function params(input: {
	readonly provider: MockLLMProvider
	readonly sandboxProvider: SandboxProvider
	readonly signal?: AbortSignal
	readonly teardownTimeoutMs?: number
	readonly runTimeoutMs?: number
}) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-sandbox-lifecycle-'))
	workdirs.push(workingDirectory)
	return {
		provider: input.provider,
		tools: new ToolRegistry(),
		sandboxProvider: input.sandboxProvider,
		...(input.signal ? { signal: input.signal } : {}),
		...(input.teardownTimeoutMs !== undefined
			? { sandboxTeardownTimeoutMs: input.teardownTimeoutMs }
			: {}),
		runConfig: {
			model: 'mock-model',
			timeoutMs: input.runTimeoutMs ?? 20_000,
			tokenBudget: 100_000,
			maxIterations: 2,
		},
		agentId: 'agent_sandbox_lifecycle',
		agentName: 'Sandbox lifecycle',
		messages: [createUserMessage('go')],
		workingDirectory,
		sessionId: 'ses_sandbox_lifecycle' as SessionId,
		topicId: 'top_sandbox_lifecycle' as TopicId,
		projectId: 'prj_sandbox_lifecycle' as ProjectId,
		tenantId: 'tnt_sandbox_lifecycle' as TenantId,
	}
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(label)), 1_000)
			}),
		])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

describe('sandbox lifecycle belongs to the run', () => {
	it('does not start sandbox or model work for a pre-cancelled run', async () => {
		const create = vi.fn(async () => boundary(async () => {}))
		const sandboxProvider: SandboxProvider = {
			id: 'pre-cancelled',
			name: 'Pre-cancelled',
			environment: 'basic',
			create,
		}
		const model = new MockLLMProvider({ turns: [{ text: 'must not run' }] })
		const caller = new AbortController()
		const reason = new RunCancelled('user')
		caller.abort(reason)

		const run = await drainQuery(
			await params({ provider: model, sandboxProvider, signal: caller.signal }),
		)

		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(create).toHaveBeenCalledTimes(0)
		expect(model.requests).toHaveLength(0)
	})

	it('settles a cancelled run even when create ignores its signal forever', async () => {
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let createSignal: AbortSignal | undefined
		const create = vi.fn((config?: SandboxCreateConfig) => {
			createSignal = config?.signal
			markStarted()
			return new Promise<Sandbox>(() => {})
		})
		const sandboxProvider = {
			id: 'held-create',
			name: 'Held create',
			environment: 'basic',
			create,
		} satisfies SandboxProvider
		const model = new MockLLMProvider({ turns: [{ text: 'must not run' }] })
		const caller = new AbortController()
		const events: RunEvent[] = []
		const pending = drainQuery(
			await params({ provider: model, sandboxProvider, signal: caller.signal }),
			(event) => {
				events.push(event)
			},
		)

		await started
		const reason = new RunCancelled('user')
		caller.abort(reason)
		const run = await within(pending, 'held sandbox create pinned drainQuery')

		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(create).toHaveBeenCalledTimes(1)
		expect(createSignal).toBeDefined()
		expect(createSignal).not.toBe(caller.signal)
		expect(createSignal?.aborted).toBe(true)
		expect(createSignal?.reason).toBe(reason)
		expect(model.requests).toHaveLength(0)
		expect(events.some((event) => event.type === 'sandbox_created')).toBe(false)
		expect(events.some((event) => event.type === 'sandbox_destroyed')).toBe(false)
		expect(events.find((event) => event.type === 'run_completed')).toMatchObject({
			type: 'run_completed',
			cancelCause: 'user',
		})
	})

	it('keeps cancellation as the first cause when transport rejects AbortError', async () => {
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		const create = vi.fn(
			(config?: SandboxCreateConfig) =>
				new Promise<Sandbox>((_resolve, reject) => {
					markStarted()
					config?.signal?.addEventListener(
						'abort',
						() => reject(new DOMException('transport aborted', 'AbortError')),
						{ once: true },
					)
				}),
		)
		const sandboxProvider = {
			id: 'abort-error-create',
			name: 'AbortError create',
			environment: 'basic',
			create,
		} satisfies SandboxProvider
		const model = new MockLLMProvider({ turns: [{ text: 'must not run' }] })
		const caller = new AbortController()
		const pending = drainQuery(
			await params({ provider: model, sandboxProvider, signal: caller.signal }),
		)

		await started
		caller.abort(new RunCancelled('user'))
		const run = await within(pending, 'transport AbortError replaced run cancellation')

		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(model.requests).toHaveLength(0)
	})

	it('settles a held create on the run timeout without starting model work', async () => {
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let createSignal: AbortSignal | undefined
		const create = vi.fn((config?: SandboxCreateConfig) => {
			createSignal = config?.signal
			markStarted()
			return new Promise<Sandbox>(() => {})
		})
		const sandboxProvider = {
			id: 'run-timeout',
			name: 'Run timeout',
			environment: 'basic',
			create,
		} satisfies SandboxProvider
		const model = new MockLLMProvider({ turns: [{ text: 'must not run' }] })
		const events: RunEvent[] = []
		const pending = drainQuery(
			await params({ provider: model, sandboxProvider, runTimeoutMs: 100 }),
			(event) => {
				events.push(event)
			},
		)

		await started
		const run = await within(pending, 'run timeout did not settle held sandbox create')

		expect(run.status).toBe('completed')
		expect(run.stopReason).toBe('timeout')
		expect(create).toHaveBeenCalledTimes(1)
		expect(createSignal).toBeDefined()
		expect(createSignal?.aborted).toBe(true)
		expect(createSignal?.reason).toMatchObject({ name: 'TimeoutError' })
		expect(model.requests).toHaveLength(0)
		expect(events.some((event) => event.type === 'sandbox_created')).toBe(false)
		expect(events.some((event) => event.type === 'sandbox_destroyed')).toBe(false)
		expect(events.find((event) => event.type === 'run_completed')).toMatchObject({
			type: 'run_completed',
			stopReason: 'timeout',
		})
	})

	it('destroys exactly once when an abandoned create returns a handle later', async () => {
		const allocation = deferred<Sandbox>()
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let markDestroyed!: () => void
		const destroyed = new Promise<void>((resolve) => {
			markDestroyed = resolve
		})
		const destroySignals: AbortSignal[] = []
		const sandbox = boundary(async (options) => {
			destroySignals.push(options?.signal as AbortSignal)
			markDestroyed()
		})
		const sandboxProvider: SandboxProvider = {
			id: 'late-create',
			name: 'Late create',
			environment: 'basic',
			create: async () => {
				markStarted()
				return await allocation.promise
			},
		}
		const caller = new AbortController()
		const model = new MockLLMProvider({ turns: [{ text: 'must not run' }] })
		const events: RunEvent[] = []
		const pending = drainQuery(
			await params({ provider: model, sandboxProvider, signal: caller.signal }),
			(event) => {
				events.push(event)
			},
		)

		await started
		caller.abort(new RunCancelled('user'))
		await within(pending, 'cancelled run did not settle before late allocation')
		allocation.resolve(sandbox)
		await within(destroyed, 'late sandbox handle was not released')

		expect(destroySignals).toHaveLength(1)
		expect(destroySignals[0]?.aborted).toBe(false)
		expect(model.requests).toHaveLength(0)
		expect(events.some((event) => event.type === 'sandbox_created')).toBe(false)
		expect(events.some((event) => event.type === 'sandbox_destroyed')).toBe(false)
	})

	it('rechecks authority after create settles instead of publishing a microtask-late handle', async () => {
		const destroy = vi.fn(async () => {})
		const sandbox = boundary(destroy)
		const caller = new AbortController()
		const sandboxProvider: SandboxProvider = {
			id: 'settle-abort-race',
			name: 'Settle abort race',
			environment: 'basic',
			create: () =>
				({
					// biome-ignore lint/suspicious/noThenProperty: a custom thenable creates the exact settlement/publication microtask boundary under test
					then(resolve: (value: Sandbox) => void) {
						resolve(sandbox)
						queueMicrotask(() => caller.abort(new RunCancelled('user')))
					},
				}) as Promise<Sandbox>,
		}
		const model = new MockLLMProvider({ turns: [{ text: 'must not run' }] })
		const events: RunEvent[] = []
		const pending = drainQuery(
			await params({ provider: model, sandboxProvider, signal: caller.signal }),
			(event) => {
				events.push(event)
			},
		)

		const run = await within(pending, 'create/abort publication race did not settle')

		expect(run.status).toBe('cancelled')
		expect(destroy).toHaveBeenCalledTimes(1)
		expect(model.requests).toHaveLength(0)
		expect(events.some((event) => event.type === 'sandbox_created')).toBe(false)
		expect(events.some((event) => event.type === 'sandbox_destroyed')).toBe(false)
	})

	it('bounds a destroy implementation that ignores its teardown signal', async () => {
		let destroySignal: AbortSignal | undefined
		const destroy = vi.fn((options?: SandboxDestroyOptions) => {
			destroySignal = options?.signal
			return new Promise<void>(() => {})
		})
		const sandboxProvider: SandboxProvider = {
			id: 'held-destroy',
			name: 'Held destroy',
			environment: 'basic',
			create: async () => boundary(destroy),
		}
		const model = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const events: RunEvent[] = []
		const run = await within(
			drainQuery(
				await params({
					provider: model,
					sandboxProvider,
					teardownTimeoutMs: 10,
				}),
				(event) => {
					events.push(event)
				},
			),
			'held sandbox destroy pinned drainQuery',
		)

		expect(run.status).toBe('completed')
		expect(run.result).toBe('done')
		expect(model.requests).toHaveLength(1)
		expect(destroy).toHaveBeenCalledTimes(1)
		expect(destroySignal).toBeDefined()
		expect(destroySignal?.aborted).toBe(true)
		expect(destroySignal?.reason).toMatchObject({ name: 'TimeoutError' })
		expect(events.some((event) => event.type === 'sandbox_created')).toBe(true)
		expect(events.some((event) => event.type === 'run_completed')).toBe(true)
		expect(events.some((event) => event.type === 'sandbox_destroyed')).toBe(false)
	})

	it('reports sandbox destruction only after teardown actually settles', async () => {
		let destroySignal: AbortSignal | undefined
		const destroy = vi.fn(async (options?: SandboxDestroyOptions) => {
			destroySignal = options?.signal
		})
		const sandboxProvider: SandboxProvider = {
			id: 'settled-destroy',
			name: 'Settled destroy',
			environment: 'basic',
			create: async () => boundary(destroy),
		}
		const events: RunEvent[] = []

		const run = await drainQuery(
			await params({
				provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
				sandboxProvider,
				teardownTimeoutMs: 100,
			}),
			(event) => {
				events.push(event)
			},
		)

		expect(run.status).toBe('completed')
		expect(destroy).toHaveBeenCalledTimes(1)
		expect(destroySignal).toBeDefined()
		expect(destroySignal?.aborted).toBe(false)
		expect(events.filter((event) => event.type === 'sandbox_destroyed')).toHaveLength(1)
		expect(events.map((event) => event.type)).toContain('run_completed')
		expect(events.findIndex((event) => event.type === 'sandbox_destroyed')).toBeGreaterThan(
			events.findIndex((event) => event.type === 'run_completed'),
		)
	})

	it.each([Number.NaN, -1, 1.5, 2_147_483_648])(
		'refuses invalid teardown timeout %s before sandbox or model work',
		async (sandboxTeardownTimeoutMs) => {
			const create = vi.fn(async () => boundary(async () => {}))
			const sandboxProvider: SandboxProvider = {
				id: 'invalid-timeout',
				name: 'Invalid timeout',
				environment: 'basic',
				create,
			}
			const model = new MockLLMProvider({ turns: [{ text: 'must not run' }] })

			await expect(
				drainQuery(
					await params({
						provider: model,
						sandboxProvider,
						teardownTimeoutMs: sandboxTeardownTimeoutMs,
					}),
				),
			).rejects.toThrow(/sandboxTeardownTimeoutMs must be an integer/)
			expect(create).toHaveBeenCalledTimes(0)
			expect(model.requests).toHaveLength(0)
		},
	)
})
