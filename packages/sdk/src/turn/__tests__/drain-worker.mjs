/**
 * A drainer process, for the multi-process `drainParkedTurns` test.
 *
 * A separate FILE rather than an inline closure because it has to import the
 * BUILT drain loop and session log, and because the whole point is that the
 * contenders share nothing but the directory. Two drainers inside one
 * process are arbitrated by the event loop, not by the lease — so a
 * single-process test reports "each turn exactly once" against an
 * implementation with no exclusion in it at all.
 *
 * Each turn it takes is resumed (`turn_resuming`), gets an assistant message
 * naming the holder and the fence it was written under, has its park answered
 * and is completed — every record appended under the drain's lease. The
 * message tells which process did which turn; the record's `gen` is the fence
 * the log actually accepted it under.
 *
 * Usage:
 *   node drain-worker.mjs <dist> <home> <slug> <tenant> <holder> <ttlMs> <mode>
 *                         [barrierEpochMs]
 *
 * mode `drain` — take everything, finish each turn, exit.
 * mode `hang`  — take the first turn, resume it and write its marker, then
 *                never finish. The parent kills it to simulate a worker that
 *                dies holding a lease.
 */

const [, , dist, home, slug, tenantId, holder, ttlMs, mode, barrierMs] = process.argv

const sdk = await import(new URL('index.js', `file://${dist.replace(/\\/g, '/')}/`).href)

const paths = new sdk.SessionPaths({ home, slug })
const index = await sdk.ScanSessionIndex.load(home)

function marker(kind, fence) {
	return {
		type: 'message',
		messageId: sdk.generateMessageId(),
		role: 'assistant',
		content: {
			role: 'assistant',
			content: JSON.stringify({ marker: 'drain-worker', kind, holder, fence }),
		},
	}
}

const settlement = {
	status: 'completed',
	iterations: 1,
	usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 },
	cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
	durationMs: 1,
	resultSource: 'model',
	abandonedTaskIds: [],
	abandonedJobIds: [],
}

// A barrier past node's startup, which varies by tens of milliseconds —
// easily enough for one drainer to finish the whole queue before another
// begins, and contenders that never overlap are not contending.
if (barrierMs) {
	const wait = Number(barrierMs) - Date.now()
	if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}

/** Whether the log refused a deliberately superseded write, per turn. */
const probes = []

const result = await pass()

async function pass() {
	return sdk.drainParkedTurns({
		index,
		tenantId,
		holder,
		ttlMs: Number(ttlMs),
		// An approval inbox's filter. It is also what makes the pass
		// exactly-once: answering a park is what takes the turn off this queue.
		park: ['outstanding'],
		onTurn: async (entry, lease) => {
			const log = sdk.DiskSessionLog.at(paths, { sessionId: entry.sessionId })
			const parked = entry.park
			await log.append(lease, {
				type: 'turn_resuming',
				turnId: entry.turnId,
				fromCheckpointId: parked.checkpointId,
			})
			await log.append(lease, {
				...marker(mode === 'hang' ? 'started' : 'done', lease.fence),
				turnId: entry.turnId,
			})
			// A deliberately superseded write, at a fence below every holding
			// this session has ever had. It MUST be refused, and it must leave
			// nothing behind — the enforcement a stalled worker meets, exercised
			// at the moment of an ordinary drain rather than only in the
			// dead-holder scenario.
			try {
				await log.append({ ...lease, fence: 0 }, { ...marker('probe', 0), turnId: entry.turnId })
				probes.push({ turnId: entry.turnId, fencedOut: false })
			} catch {
				probes.push({ turnId: entry.turnId, fencedOut: true })
			}
			if (mode === 'hang') {
				// Tell the parent the lease is held and the work is under way, then
				// stop being a process that will ever finish. The park stays
				// outstanding, which is what makes the turn reclaimable.
				process.stdout.write(`${JSON.stringify({ holding: entry.turnId, lease })}\n`)
				await new Promise(() => {})
			}
			// Answer the park and settle the turn: doing the work is what takes
			// the turn off the queue.
			await log.append(lease, {
				type: 'decision_resolved',
				turnId: entry.turnId,
				decisionId: parked.checkpointId,
				decision: { action: 'approve_tools' },
				resolvedBy: { kind: 'system', role: 'sys_drain_worker', tenantId },
			})
			await log.append(lease, {
				type: 'turn_completed',
				turnId: entry.turnId,
				result: 'drained',
				settlement,
			})
		},
	})
}

process.stdout.write(`${JSON.stringify({ holder, probes, ...result })}\n`)
index.close()
