/**
 * One process racing others for an occurrence claim, and appending history.
 * argv: <home> <jobId> <key> <runId> <appends>
 */
import { schedulePaths } from '../paths.js'
import { claimOccurrence } from '../store/claims.js'
import { appendHistory } from '../store/history.js'

const [home = '', jobId = '', key = '', runId = '', appends = '0'] = process.argv.slice(2)
const paths = schedulePaths(home)
const won = claimOccurrence(paths, {
	jobId,
	key,
	runId,
	daemonEpoch: runId,
	at: new Date().toISOString(),
})
for (let i = 0; i < Number(appends); i++) {
	const at = new Date().toISOString()
	appendHistory(paths, jobId, {
		v: 1,
		kind: 'skip',
		at,
		scheduledFor: at,
		reason: `${runId}-${i}`,
		count: 1,
	})
}
process.send?.({ won })
