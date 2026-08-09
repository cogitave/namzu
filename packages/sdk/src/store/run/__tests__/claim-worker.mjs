/**
 * A worker process that races for a batch of runs, for the multi-process
 * claim test. Prints one JSON line and exits.
 *
 * A separate FILE rather than an inline script because it has to import the
 * built store, and because the whole point is that the contenders share
 * nothing but the directory — a shared module instance would put the
 * arbitration back inside one process, which is the condition the claim
 * exists to escape.
 *
 * It races a BATCH rather than one run, and that is not a convenience. A
 * check-then-act implementation is wrong only when two workers are inside the
 * same read-write window at the same moment, which is microseconds wide; two
 * processes released at the same millisecond usually still miss each other,
 * and a single-run race reports "correct" against an implementation that is
 * not. Hundreds of attempts back to back turn a rare interleaving into a
 * near-certain one, and the assertion is over the whole batch: every run
 * claimed by exactly one worker.
 *
 * Usage: node claim-worker.mjs <distDir> <baseDir> <prefix> <count> <holder> <ttlMs> <barrierEpochMs>
 */

const [, , dist, baseDir, prefix, count, holder, ttlMs, barrierMs] = process.argv

const { DiskCheckpointStore } = await import(
	new URL('store/run/checkpoint-disk.js', `file://${dist.replace(/\\/g, '/')}/`).href
)

const store = new DiskCheckpointStore({ baseDir })
const runIds = Array.from({ length: Number(count) }, (_, i) => `${prefix}${i}`)

// A barrier, so the workers contend rather than run in sequence. Node startup
// varies by tens of milliseconds, which is easily enough for one worker to
// finish the whole batch before another begins — and contenders that never
// overlap are not contending.
const at = Number(barrierMs)
const wait = at - Date.now()
if (wait > 0) await new Promise((r) => setTimeout(r, wait))

const won = []
for (const runId of runIds) {
	const claim = await store.claimRun(
		{ tenantId: 'tnt_race', projectId: 'prj_race', sessionId: 'ses_race', runId },
		{ holder, ttlMs: Number(ttlMs) },
	)
	if (claim) won.push({ runId, fence: claim.fence })
}

process.stdout.write(`${JSON.stringify({ holder, won })}\n`)
