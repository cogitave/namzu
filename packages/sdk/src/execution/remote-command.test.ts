import { describe, expect, it, vi } from 'vitest'

import type {
	CommandExecutor,
	CommandOptions,
	CommandResult,
	RemoteCommandHandler,
	RemoteTarget,
} from '../types/connector/index.js'
import { CommandCancellationUnsupportedError, RemoteExecutionBusyError } from './errors.js'
import { HybridExecutionContext } from './hybrid.js'
import { RemoteExecutionContext } from './remote.js'

const target: RemoteTarget = { type: 'ssh', host: 'remote.example.com' }

function commandResult(): CommandResult {
	return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }
}

interface Deferred<T> {
	promise: Promise<T>
	resolve(value: T | PromiseLike<T>): void
	reject(reason?: unknown): void
}

function deferred<T>(): Deferred<T> {
	let resolve!: Deferred<T>['resolve']
	let reject!: Deferred<T>['reject']
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

class StatefulCommandExecutor implements CommandExecutor {
	calls = 0
	command: string | undefined
	args: string[] | undefined
	options: CommandOptions | undefined

	async executeCommand(
		command: string,
		args: string[] = [],
		options?: CommandOptions,
	): Promise<CommandResult> {
		this.calls++
		this.command = command
		this.args = args
		this.options = options
		return commandResult()
	}
}

function createHybrid(strategy: 'local-first' | 'remote-first' | 'round-robin') {
	return new HybridExecutionContext({
		id: `hybrid-${strategy}`,
		local: { cwd: process.cwd() },
		remotes: [target],
		routingStrategy: strategy,
	})
}

function remoteAt(context: HybridExecutionContext): RemoteExecutionContext {
	const remote = context.getRemotes()[0]
	if (!remote) throw new Error('Expected one remote execution context')
	return remote
}

describe('RemoteExecutionContext structured command migration', () => {
	it('prefers the explicit executor and retains argv, options, and method receiver identity', async () => {
		const executor = new StatefulCommandExecutor()
		const legacy = {
			executeRemote: vi.fn().mockResolvedValue(commandResult()),
		} satisfies RemoteCommandHandler
		const context = new RemoteExecutionContext({
			id: 'structured',
			target,
			commandExecutor: executor,
			commandHandler: legacy,
		})
		const args = ['a b', ';', '', '✓']
		const options: CommandOptions = { cwd: 'nested', shell: true, timeoutMs: 1200 }
		await context.connect()

		await context.executeCommand('tool', args, options)

		expect(executor.calls).toBe(1)
		expect(executor.command).toBe('tool')
		expect(executor.args).toBe(args)
		expect(executor.options).toBe(options)
		expect(legacy.executeRemote).not.toHaveBeenCalled()
	})

	it('canonicalizes omitted args to an empty array for the structured executor', async () => {
		const executor = new StatefulCommandExecutor()
		const context = new RemoteExecutionContext({
			id: 'omitted-args',
			target,
			commandExecutor: executor,
		})
		await context.connect()

		await context.executeCommand('tool')

		expect(executor.args).toEqual([])
	})

	it.each([
		{ args: [] as string[], expected: 'tool' },
		{ args: [''], expected: 'tool ' },
		{ args: ['a b', ';', '', '✓'], expected: 'tool a b ;  ✓' },
	])('retains the legacy joined-string fallback for argv $args', async ({ args, expected }) => {
		const options: CommandOptions = { timeoutMs: 0 }
		const legacyObject = {
			executeRemote: vi.fn().mockResolvedValue(commandResult()),
			// This unrelated property is valid on an existing structural value. The
			// migration must never discover or call it through duck typing.
			executeCommand: (_numericId: number) => commandResult(),
		}
		const legacy: RemoteCommandHandler = legacyObject
		const context = new RemoteExecutionContext({ id: 'legacy', target, commandHandler: legacy })
		await context.connect()

		await context.executeCommand('tool', args, options)

		expect(legacyObject.executeRemote).toHaveBeenCalledWith(expected, options)
	})

	it('keeps legacy direct execution separate from a configured structured executor', async () => {
		const executor = new StatefulCommandExecutor()
		const context = new RemoteExecutionContext({
			id: 'legacy-direct',
			target,
			commandExecutor: executor,
		})
		await context.connect()

		await expect(context.executeRemote('tool --legacy')).rejects.toThrow(
			'No remote command handler configured',
		)
		expect(executor.calls).toBe(0)
	})

	it('refuses before invoking either dependency when disconnected', async () => {
		const executor = new StatefulCommandExecutor()
		const legacy = {
			executeRemote: vi.fn().mockResolvedValue(commandResult()),
		} satisfies RemoteCommandHandler
		const context = new RemoteExecutionContext({
			id: 'disconnected',
			target,
			commandExecutor: executor,
			commandHandler: legacy,
		})

		await expect(context.executeCommand('tool')).rejects.toThrow('is not connected')
		expect(executor.calls).toBe(0)
		expect(legacy.executeRemote).not.toHaveBeenCalled()
	})

	it('reports a missing implementation before connection state', async () => {
		const context = new RemoteExecutionContext({ id: 'unconfigured', target })

		await expect(context.executeCommand('tool')).rejects.toThrow(
			'No remote command executor configured',
		)
	})

	it('refuses a caller signal before invoking a structured executor', async () => {
		const executor = new StatefulCommandExecutor()
		const context = new RemoteExecutionContext({
			id: 'structured-cancellation',
			target,
			commandExecutor: executor,
		})
		await context.connect()

		await expect(
			context.executeCommand('tool', [], { signal: new AbortController().signal }),
		).rejects.toBeInstanceOf(CommandCancellationUnsupportedError)
		expect(executor.calls).toBe(0)
	})

	it('refuses even a pre-aborted signal before invoking a legacy handler', async () => {
		const caller = new AbortController()
		caller.abort(new Error('already stopped'))
		const legacy = {
			executeRemote: vi.fn().mockResolvedValue(commandResult()),
		} satisfies RemoteCommandHandler
		const context = new RemoteExecutionContext({
			id: 'legacy-cancellation',
			target,
			commandHandler: legacy,
		})
		await context.connect()

		await expect(
			context.executeCommand('tool', [], { signal: caller.signal }),
		).rejects.toMatchObject({
			code: 'command_cancellation_unsupported',
			contextId: context.id,
		})
		await expect(context.executeRemote('tool', { signal: caller.signal })).rejects.toBeInstanceOf(
			CommandCancellationUnsupportedError,
		)
		expect(legacy.executeRemote).not.toHaveBeenCalled()
	})

	it('preserves implementation then connection error precedence ahead of cancellation refusal', async () => {
		const signal = new AbortController().signal
		const unconfigured = new RemoteExecutionContext({ id: 'unconfigured-signal', target })
		await expect(unconfigured.executeCommand('tool', [], { signal })).rejects.toThrow(
			'No remote command executor configured',
		)

		const executor = new StatefulCommandExecutor()
		const disconnected = new RemoteExecutionContext({
			id: 'disconnected-signal',
			target,
			commandExecutor: executor,
		})
		await expect(disconnected.executeCommand('tool', [], { signal })).rejects.toThrow(
			'is not connected',
		)
		expect(executor.calls).toBe(0)
	})

	it('refuses disconnect while a command is active and succeeds after fulfillment', async () => {
		const result = deferred<CommandResult>()
		const executor: CommandExecutor = {
			executeCommand: () => result.promise,
		}
		const context = new RemoteExecutionContext({
			id: 'busy-fulfilled',
			target,
			commandExecutor: executor,
		})
		await context.connect()

		const running = context.executeCommand('held')
		await expect(context.disconnect()).rejects.toBeInstanceOf(RemoteExecutionBusyError)
		expect(context.isConnected()).toBe(true)

		result.resolve(commandResult())
		await running
		await context.disconnect()
		expect(context.isConnected()).toBe(false)
	})

	it('reports the exact active count when several commands hold disconnect', async () => {
		const result = deferred<CommandResult>()
		const context = new RemoteExecutionContext({
			id: 'busy-multiple',
			target,
			commandExecutor: { executeCommand: () => result.promise },
		})
		await context.connect()

		const first = context.executeCommand('first')
		const second = context.executeCommand('second')
		await expect(context.disconnect()).rejects.toMatchObject({
			code: 'remote_execution_busy',
			activeCommandCount: 2,
			message: expect.stringContaining('2 active commands'),
		})

		result.resolve(commandResult())
		await Promise.all([first, second])
		await expect(context.disconnect()).resolves.toBeUndefined()
	})

	it('registers ownership before a remote executor can re-enter disconnect', async () => {
		let disconnectAttempt: Promise<void> | undefined
		const owner: { context?: RemoteExecutionContext } = {}
		const executor: CommandExecutor = {
			executeCommand: () => {
				if (!owner.context) throw new Error('context was not assigned')
				disconnectAttempt = owner.context.disconnect()
				return Promise.resolve(commandResult())
			},
		}
		const context = new RemoteExecutionContext({
			id: 'reentrant-disconnect',
			target,
			commandExecutor: executor,
		})
		owner.context = context
		await context.connect()

		const running = context.executeCommand('reentrant')
		expect(disconnectAttempt).toBeDefined()
		await expect(disconnectAttempt).rejects.toBeInstanceOf(RemoteExecutionBusyError)
		expect(context.isConnected()).toBe(true)
		await running
		await expect(context.disconnect()).resolves.toBeUndefined()
	})

	it('releases active ownership after rejection and synchronous throw', async () => {
		const rejected = deferred<CommandResult>()
		const rejection = new Error('remote rejected')
		const rejecting = new RemoteExecutionContext({
			id: 'busy-rejected',
			target,
			commandExecutor: { executeCommand: () => rejected.promise },
		})
		await rejecting.connect()
		const running = rejecting.executeCommand('held')
		await expect(rejecting.disconnect()).rejects.toBeInstanceOf(RemoteExecutionBusyError)
		rejected.reject(rejection)
		await expect(running).rejects.toBe(rejection)
		await expect(rejecting.disconnect()).resolves.toBeUndefined()

		const synchronousFailure = new Error('synchronous failure')
		const throwing = new RemoteExecutionContext({
			id: 'sync-throw',
			target,
			commandExecutor: {
				executeCommand: () => {
					throw synchronousFailure
				},
			},
		})
		await throwing.connect()
		await expect(throwing.executeCommand('held')).rejects.toBe(synchronousFailure)
		await expect(throwing.disconnect()).resolves.toBeUndefined()
	})

	it('fails teardown promptly while busy, publishes no success, and permits retry', async () => {
		const result = deferred<CommandResult>()
		const context = new RemoteExecutionContext({
			id: 'busy-teardown',
			target,
			commandExecutor: { executeCommand: () => result.promise },
		})
		const events: string[] = []
		context.on((event) => events.push(event.type))
		await context.connect()
		const running = context.executeCommand('held')

		await expect(context.teardown()).rejects.toMatchObject({
			code: 'remote_execution_busy',
			activeCommandCount: 1,
		})
		expect(events).not.toContain('context_teardown')
		await expect(context.executeCommand('too-late')).rejects.toThrow('tearing down')

		result.resolve(commandResult())
		await running
		await context.teardown()
		expect(events.filter((event) => event === 'remote_disconnected')).toHaveLength(1)
		expect(events.filter((event) => event === 'context_teardown')).toHaveLength(1)
	})
})

describe('HybridExecutionContext structured command reachability', () => {
	it('preserves argv through remote-first routing', async () => {
		const context = createHybrid('remote-first')
		const remote = remoteAt(context)
		const executor = new StatefulCommandExecutor()
		const args = ['a b', ';', '', '✓']
		const options: CommandOptions = { env: { PURPOSE: 'remote-first' } }
		remote.setCommandExecutor(executor)
		await remote.connect()

		await context.executeCommand('tool', args, options)

		expect(executor.command).toBe('tool')
		expect(executor.args).toBe(args)
		expect(executor.options).toBe(options)
	})

	it('preserves argv when round-robin reaches a remote', async () => {
		const context = createHybrid('round-robin')
		const remote = remoteAt(context)
		const executor = new StatefulCommandExecutor()
		const local = vi.spyOn(context.getLocal(), 'executeCommand').mockResolvedValue(commandResult())
		const args = ['two words', '&&', '✓']
		remote.setCommandExecutor(executor)
		await remote.connect()

		await context.executeCommand('first-local')
		await context.executeCommand('then-remote', args)

		expect(local).toHaveBeenCalledOnce()
		expect(executor.command).toBe('then-remote')
		expect(executor.args).toBe(args)
	})

	it('does not invoke a connected remote while routing local-first', async () => {
		const context = createHybrid('local-first')
		const remote = remoteAt(context)
		const executor = new StatefulCommandExecutor()
		const local = vi.spyOn(context.getLocal(), 'executeCommand').mockResolvedValue(commandResult())
		remote.setCommandExecutor(executor)
		await remote.connect()

		await context.executeCommand('local', ['only'])

		expect(local).toHaveBeenCalledOnce()
		expect(executor.calls).toBe(0)
	})

	it('does not silently fall back to local when a connected remote is unconfigured', async () => {
		const context = createHybrid('remote-first')
		const remote = remoteAt(context)
		const local = vi.spyOn(context.getLocal(), 'executeCommand').mockResolvedValue(commandResult())
		await remote.connect()

		await expect(context.executeCommand('remote')).rejects.toThrow(
			'No remote command executor configured',
		)
		expect(local).not.toHaveBeenCalled()
	})

	it('preserves remote cancellation refusal through remote-first and round-robin routing', async () => {
		const signal = new AbortController().signal
		const remoteFirst = createHybrid('remote-first')
		const remoteFirstTarget = remoteAt(remoteFirst)
		const remoteFirstExecutor = new StatefulCommandExecutor()
		remoteFirstTarget.setCommandExecutor(remoteFirstExecutor)
		await remoteFirstTarget.connect()

		await expect(remoteFirst.executeCommand('remote', [], { signal })).rejects.toBeInstanceOf(
			CommandCancellationUnsupportedError,
		)
		expect(remoteFirstExecutor.calls).toBe(0)

		const roundRobin = createHybrid('round-robin')
		const roundRobinTarget = remoteAt(roundRobin)
		const roundRobinExecutor = new StatefulCommandExecutor()
		vi.spyOn(roundRobin.getLocal(), 'executeCommand').mockResolvedValue(commandResult())
		roundRobinTarget.setCommandExecutor(roundRobinExecutor)
		await roundRobinTarget.connect()
		await roundRobin.executeCommand('first-local')

		await expect(roundRobin.executeCommand('then-remote', [], { signal })).rejects.toBeInstanceOf(
			CommandCancellationUnsupportedError,
		)
		expect(roundRobinExecutor.calls).toBe(0)
	})

	it('propagates a busy remote from disconnectAllRemotes', async () => {
		const result = deferred<CommandResult>()
		const context = createHybrid('remote-first')
		const remote = remoteAt(context)
		remote.setCommandExecutor({ executeCommand: () => result.promise })
		await remote.connect()
		const running = context.executeCommand('held')

		await expect(context.disconnectAllRemotes()).rejects.toBeInstanceOf(RemoteExecutionBusyError)
		expect(remote.isConnected()).toBe(true)

		result.resolve(commandResult())
		await running
		await context.disconnectAllRemotes()
		expect(remote.isConnected()).toBe(false)
	})
})
