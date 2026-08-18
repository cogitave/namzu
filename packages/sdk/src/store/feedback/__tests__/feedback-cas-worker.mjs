/**
 * Real-process contender for feedback update CAS.
 *
 * Usage:
 * node feedback-cas-worker.mjs <distDir> <feedbackDir> <runsDir> <prefix> <count> <worker> <barrierMs>
 */

const [, , dist, feedbackDir, runsDir, prefix, countRaw, worker, barrierRaw] = process.argv
const count = Number(countRaw)
const barrier = Number(barrierRaw)
const diskModule = new URL(
	'store/feedback/disk.js',
	`file://${dist.replace(/\\\\/g, '/')}/`,
).href

const wait = barrier - Date.now()
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))

const { DiskMessageFeedbackStore } = await import(diskModule)
const store = new DiskMessageFeedbackStore({ rootDir: feedbackDir, runsDir })
const won = []
const unexpected = []

for (let i = 0; i < count; i++) {
	const messageId = `${prefix}${i}`
	const rating = worker === 'w0' ? 'good' : 'bad'
	try {
		const record = await store.putMessageFeedback({
			runId: 'run_feedback_update_proc',
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
