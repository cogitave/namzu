/**
 * Real-process contender for the topic CAS observers.
 *
 * Usage:
 * node topic-cas-worker.mjs <distDir> <rootDir> <kind> <scopeJson> <worker> <barrierMs>
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [, , dist, rootDir, kind, scopeJson, worker, barrierRaw] = process.argv
const { tenantId, ids } = JSON.parse(scopeJson)
const barrier = Number(barrierRaw)

const stateModule = pathToFileURL(join(dist, 'store/topic/state.js')).href
const objectiveModule = pathToFileURL(join(dist, 'store/topic/objective.js')).href

const wait = barrier - Date.now()
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))

const won = []
const unexpected = []

if (kind === 'state') {
	const { DiskTopicStateStore } = await import(stateModule)
	const store = new DiskTopicStateStore({ rootDir })
	const mode = worker === 'w0' ? 'plan' : 'auto'
	for (const topicId of ids) {
		try {
			await store.setPermissionMode(topicId, tenantId, mode, { revision: 0 })
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
	for (const id of ids) {
		try {
			await store.beginRound(id, tenantId, { revision: 1 })
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
