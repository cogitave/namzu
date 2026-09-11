import { realpath } from 'node:fs/promises'
import type { CommandContext } from '../../commands/types.js'
import { openSessions } from '../sessions/store.js'
import { runOwnedResident } from './owned-runner.js'
import type { ResidentWorkerLaunch } from './runner-launch.js'
import { finishRunner, readRunner } from './runner-store.js'
import { createResidentSessionStep } from './session-step.js'
import { lookupResident } from './storage.js'

// Internal child entrypoint. Launch parameters arrive only through the parent's
// IPC channel; credentials and resolved configuration are never copied to disk.
async function main(): Promise<number> {
	if (!process.send)
		throw new Error('Resident workers must be started through namzu resident start.')
	const controller = new AbortController()
	let handedOff = false
	const stop = () =>
		controller.abort(new Error('Resident worker interrupted before or during execution.'))
	const disconnected = () => {
		if (!handedOff) stop()
	}
	process.on('disconnect', disconnected)
	process.once('SIGINT', stop)
	process.once('SIGTERM', stop)
	let resident: Awaited<ReturnType<typeof lookupResident>> = null
	let owner: ReturnType<typeof readRunner> = null
	let lifecycleStarted = false
	try {
		const launch = await new Promise<ResidentWorkerLaunch>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error('Resident startup parameters did not arrive.')),
				15_000,
			)
			process.once('message', (message) => {
				clearTimeout(timer)
				if (
					!message ||
					typeof message !== 'object' ||
					(message as ResidentWorkerLaunch).version !== 1
				) {
					reject(new Error('Invalid resident worker launch.'))
					return
				}
				resolve(message as ResidentWorkerLaunch)
			})
		})
		controller.signal.throwIfAborted()
		resident = await lookupResident(launch.cwd, launch.agentKey)
		if (!resident || resident.cwd !== launch.cwd || (await realpath(launch.cwd)) !== launch.cwd)
			throw new Error('Resident execution directory changed before worker startup.')
		const candidate = readRunner(resident)
		if (candidate?.instanceId !== launch.instanceId || candidate.phase !== 'reserved')
			throw new Error('Resident worker does not own this startup reservation.')
		owner = candidate
		const sessions = await openSessions(resident.cwd)
		if (sessions.projectId !== resident.projectId || sessions.tenantId !== resident.tenantId)
			throw new Error('Resident project or tenant changed before worker startup.')
		const ctx: CommandContext = {
			config: launch.config,
			formatter: { name: 'json', print() {}, info() {}, error() {} },
		}
		const step = createResidentSessionStep({
			ctx,
			cwd: resident.cwd,
			sessions,
			flags: launch.flags,
			toolLoading: launch.toolLoading,
			contextProfile: launch.contextProfile,
			artifactsRoot: resident.artifactsRoot,
		})
		lifecycleStarted = true
		const result = await runOwnedResident({
			resident,
			owner,
			step,
			signal: controller.signal,
			keepAlive: true,
			maxIdleMs: launch.maxIdleMs,
			ready: async (ready, signal) => {
				await new Promise<void>((resolve, reject) => {
					const cleanup = () => {
						clearTimeout(timer)
						process.removeListener('message', go)
						signal.removeEventListener('abort', aborted)
					}
					const aborted = () => {
						cleanup()
						reject(signal.reason)
					}
					const go = (message: unknown) => {
						if (
							message &&
							typeof message === 'object' &&
							(message as Record<string, unknown>).kind === 'go' &&
							(message as Record<string, unknown>).instanceId === ready.instanceId
						) {
							handedOff = true
							cleanup()
							resolve()
						}
					}
					const timer = setTimeout(() => {
						cleanup()
						reject(new Error('Resident startup handoff timed out.'))
					}, 15_000)
					process.on('message', go)
					signal.addEventListener('abort', aborted, { once: true })
					if (signal.aborted) {
						aborted()
						return
					}
					process.send?.({ kind: 'ready', instanceId: ready.instanceId }, (error) => {
						if (error) {
							cleanup()
							reject(error)
						}
					})
				})
			},
		})
		return ['unresolved', 'contended'].includes(result.status)
			? 1
			: result.status === 'cancelled'
				? 130
				: 0
	} catch (error) {
		if (!lifecycleStarted && resident && owner?.phase === 'reserved') {
			try {
				finishRunner(resident, owner, 'startup_failed')
			} catch {
				/* A successor is never released by this worker. */
			}
		}
		if (process.connected)
			await new Promise<void>((resolve) => {
				process.send?.(
					{
						kind: 'error',
						instanceId: owner?.instanceId,
						message: error instanceof Error ? error.message : String(error),
					},
					() => resolve(),
				)
			})
		return 1
	} finally {
		process.removeListener('disconnect', disconnected)
		process.removeListener('SIGINT', stop)
		process.removeListener('SIGTERM', stop)
	}
}

void main().then(
	(code) => process.exit(code),
	() => process.exit(1),
)
