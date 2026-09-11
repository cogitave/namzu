import { setTimeout as sleep } from 'node:timers/promises'
import { DiskResidentAgenda, ResidentHost } from '../../../../dist/index.js'

const [root, tenantId, mode = 'normal'] = process.argv.slice(2)
const agenda = new DiskResidentAgenda(root, { tenantId, agentKey: 'keep-alive-process' })
const controller = new AbortController()
const interrupt = () => controller.abort()
process.once('SIGTERM', interrupt)
const report = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
let calls = 0
let previousRevision = 0
let idleReads = 0
const read = agenda.read.bind(agenda)
agenda.read = async () => {
	const state = await read()
	if (
		state &&
		!state.paused &&
		!state.pursuits.some(
			(pursuit) =>
				pursuit.state.phase === 'running' ||
				(pursuit.state.phase === 'waiting' &&
					pursuit.state.wakeAt !== null &&
					pursuit.state.wakeAt <= Date.now()),
		)
	) {
		idleReads = state.revision === previousRevision ? idleReads + 1 : 1
		previousRevision = state.revision
		if (idleReads === 3) report({ kind: 'idle', calls, revision: state.revision })
	}
	return state
}

try {
	const host = new ResidentHost(agenda, async (_pursuit, signal) => {
		calls++
		if (mode === 'abort') {
			report({ kind: 'entered', calls })
			try {
				await sleep(60_000, undefined, { signal })
			} catch (error) {
				if (!signal.aborted) throw error
			} finally {
				await sleep(5)
				report({ kind: 'drained', calls, aborted: signal.aborted })
			}
			return { kind: 'complete', summary: 'Must remain unresolved after interruption' }
		}
		return calls === 1
			? { kind: 'wait', wakeAt: null, summary: 'First observation retained' }
			: { kind: 'complete', summary: 'Additional evidence verified' }
	})
	// No IPC connection or fixture heartbeat holds this process open. During
	// idle waits only the host's own timer can keep the pending invocation alive.
	const result = await host.run({
		signal: controller.signal,
		maxSteps: 2,
		maxIdleMs: 10,
		keepAlive: true,
	})
	report({ kind: 'result', calls, result })
} catch (error) {
	report({ kind: 'failure', message: error instanceof Error ? error.message : String(error) })
	process.exitCode = 1
} finally {
	process.removeListener('SIGTERM', interrupt)
}
