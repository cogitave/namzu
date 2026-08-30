import { describe, expect, it, vi } from 'vitest'

import type {
	CommandExecutor,
	CommandOptions,
	CommandResult,
	RemoteCommandHandler,
	RemoteTarget,
} from '../types/connector/index.js'
import { HybridExecutionContext } from './hybrid.js'
import { RemoteExecutionContext } from './remote.js'

const target: RemoteTarget = { type: 'ssh', host: 'remote.example.com' }

function commandResult(): CommandResult {
	return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }
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
})
