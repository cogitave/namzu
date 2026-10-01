import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { SandboxDetachedProcess, SandboxSpawnOptions } from '@namzu/sdk'
import type { DetachedWorkerConfiguration } from './detached-worker.js'

export interface DetachedProcessOptions {
	readonly executionUrl: string
	readonly token: string
	readonly retire: () => Promise<void>
	/** Tests using source modules select the already built worker entry. */
	readonly workerPath?: string
}

export interface OwnedDetachedProcess extends SandboxDetachedProcess {
	readonly closed: Promise<void>
	terminate(signal?: NodeJS.Signals): Promise<void>
}

/** Credentials and command payload travel over private IPC, never argv. */
export function startDetachedGuestProcess(
	options: DetachedProcessOptions,
	command: string,
	args: readonly string[] = [],
	spawnOptions?: SandboxSpawnOptions,
): OwnedDetachedProcess {
	const child = spawn(
		process.execPath,
		[options.workerPath ?? fileURLToPath(new URL('./detached-worker.js', import.meta.url))],
		{
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		},
	)
	let physicallyClosed = false
	let confirmed = false
	let recoveryRequired = false
	let retirement: Promise<void> | undefined
	const waiters = new Set<{
		resolve: () => void
		reject: (error: Error) => void
	}>()
	const closed = new Promise<void>((resolve) =>
		child.once('close', () => {
			physicallyClosed = true
			resolve()
			if (!confirmed) void retire().catch(() => {})
		}),
	)
	const acceptConfirmation = () => {
		confirmed = true
		recoveryRequired = false
		void closed.then(() => {
			for (const waiter of waiters) waiter.resolve()
			waiters.clear()
		})
	}
	const retire = (): Promise<void> => {
		if (retirement) return retirement
		const attempt = Promise.resolve()
			.then(() => options.retire())
			.then(
				() => {
					acceptConfirmation()
					if (child.connected) child.send({ type: 'retired', confirmed: true }, () => {})
				},
				() => {
					recoveryRequired = true
					const error = new Error(
						'Guest termination and computer retirement could not be confirmed; operator recovery or a termination retry is required',
					)
					for (const waiter of waiters) waiter.reject(error)
					waiters.clear()
					if (child.connected) child.send({ type: 'retired', confirmed: false }, () => {})
					throw error
				},
			)
			.finally(() => {
				retirement = undefined
			})
		retirement = attempt
		return attempt
	}
	const requestCancellation = (signal: NodeJS.Signals) => {
		if (confirmed) return
		if (recoveryRequired || physicallyClosed) {
			void retire().catch(() => {})
			return
		}
		if (child.connected)
			child.send({ type: 'cancel', signal }, (error) => {
				if (error) void retire().catch(() => {})
			})
	}
	child.once('spawn', () => {
		const config: DetachedWorkerConfiguration = {
			type: 'start',
			executionUrl: options.executionUrl,
			token: options.token,
			command,
			args: [...args],
			...(spawnOptions?.cwd ? { cwd: spawnOptions.cwd } : {}),
			...(spawnOptions?.env ? { env: spawnOptions.env } : {}),
		}
		if (child.connected)
			child.send(config, (error) => {
				if (error)
					child.emit('error', new Error('The guest background bridge could not be initialized'))
			})
	})
	child.on('message', (raw: unknown) => {
		if (!raw || typeof raw !== 'object' || !('type' in raw)) return
		if (raw.type === 'terminal-confirmed') acceptConfirmation()
		if (raw.type === 'retire-computer') void retire().catch(() => {})
	})
	return {
		child,
		closed,
		kill(signal) {
			// Both TERM and escalation request confirmed guest cancellation.
			// SIGKILL must never merely kill this host bridge and leave its
			// remote shell running after the registry believes the job stopped.
			requestCancellation(signal)
		},
		terminate(signal = 'SIGTERM') {
			if (confirmed) return closed
			return new Promise<void>((resolve, reject) => {
				waiters.add({ resolve, reject })
				requestCancellation(signal)
			})
		},
	}
}
