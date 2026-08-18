/**
 * Real-process contender for the topic CAS observers.
 *
 * Usage:
 * node topic-cas-worker.mjs <distDir> <rootDir> <kind> <prefix> <count> <worker> <barrierMs>
 */

const [, , dist, rootDir, kind, prefix, countRaw, worker, barrierRaw] = process.argv
const count = Number(countRaw)
const barrier = Number(barrierRaw)

const stateModule = new URL('store/topic/state.js', `file://${dist.replace(/\\/g, '/')}/`).href
const objectiveModule = new URL('store/topic/objective.js', `file://${dist.replace(/\\/g, '/')}/`).href

const wait = barrier - Date.now()
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))

const won = []
const unexpected = []

if (kind === 'state') {
	const { DiskTopicStateStore } = await import(stateModule)
	const store = new DiskTopicStateStore({ rootDir })
	const mode = worker === 'w0' ? 'plan' : 'auto'
	for (let i = 0; i < count; i++) {
		const topicId = `${prefix}${i}`
		try {
			await store.setPermissionMode(topicId, 'tnt_proc', mode, { revision: 0 })
			won.push({ id: topicId, mode, worker })
		} catch (error) {
			if (error?.name !== 'StaleTopicStateError') {
				unexpected.push({ id: topicId, name: error?.name, message: error?.message })
			}
		}
	}
} else if (kind === 'objective') {
	const { DiskTopicObjectiveStore } = await import(objectiveModule)
	const store = new DiskTopicObjectiveStore({ rootDir })
	for (let i = 0; i < count; i++) {
		const id = `${prefix}${i}`
		try {
			await store.beginRound(id, 'tnt_proc', { revision: 1 })
			won.push({ id, worker })
		} catch (error) {
			if (error?.name !== 'StaleObjectiveError') {
				unexpected.push({ id, name: error?.name, message: error?.message })
			}
		}
	}
} else {
	throw new Error(`Unknown topic CAS worker kind: ${kind}`)
}

process.stdout.write(`${JSON.stringify({ won, unexpected })}\n`)
