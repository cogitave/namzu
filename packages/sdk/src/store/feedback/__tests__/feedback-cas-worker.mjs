/**
 * Real-process contender for feedback update CAS.
 *
 * Usage:
 * node feedback-cas-worker.mjs <distDir> <feedbackDir> <runsDir> <scopeJson> <worker> <barrierMs>
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [, , dist, feedbackDir, runsDir, scopeJson, worker, barrierRaw] = process.argv
const { runId, ids } = JSON.parse(scopeJson)
const barrier = Number(barrierRaw)
const diskModule = pathToFileURL(join(dist, 'store/feedback/disk.js')).href

const wait = barrier - Date.now()
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))

const { DiskMessageFeedbackStore } = await import(diskModule)
const store = new DiskMessageFeedbackStore({ rootDir: feedbackDir, runsDir })
const won = []
const unexpected = []

for (const messageId of ids) {
	const rating = worker === 'w0' ? 'good' : 'bad'
	try {
		const record = await store.putMessageFeedback({
			runId,
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
