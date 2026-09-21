/**
 * Real-process contender for feedback update CAS.
 *
 * Usage:
 * node feedback-cas-worker.mjs <distDir> <namzuHome> <slug> <scopeJson> <worker> <barrierMs>
 *
 * Accepts exactly the message ids in <scopeJson>: the contest is over the
 * revision directory, not over the session-log check.
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [, , dist, home, slug, scopeJson, worker, barrierRaw] = process.argv
const { sessionId, ids } = JSON.parse(scopeJson)
const barrier = Number(barrierRaw)
const diskModule = pathToFileURL(join(dist, 'store/feedback/disk.js')).href
const pathsModule = pathToFileURL(join(dist, 'session/paths.js')).href

const wait = barrier - Date.now()
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))

const { DiskMessageFeedbackStore } = await import(diskModule)
const { SessionPaths } = await import(pathsModule)
const known = new Set(ids)
const store = new DiskMessageFeedbackStore(
	{ paths: new SessionPaths({ home, slug }) },
	async (_sessionId, messageId) => known.has(messageId),
)
const won = []
const unexpected = []

for (const messageId of ids) {
	const rating = worker === 'w0' ? 'good' : 'bad'
	try {
		const record = await store.putMessageFeedback({
			sessionId,
			messageId,
			rating,
			note: worker,
			expectedVersion: 1,
		})
		won.push({
			id: messageId,
			rating: record.rating,
			note: record.note,
			worker,
		})
	} catch (error) {
		if (error?.name !== 'StaleFeedbackError') {
			unexpected.push({
				id: messageId,
				name: error?.name,
				message: error?.message,
			})
		}
	}
}

process.stdout.write(`${JSON.stringify({ won, unexpected })}\n`)
