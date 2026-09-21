/**
 * A worker process that rebuilds one session index and then opens it, for the
 * concurrent-rebuild test. Prints one JSON line and exits.
 *
 * A separate file, importing the built SDK, because the contenders must share
 * nothing but the directory: two index objects in one process would put the
 * arbitration back inside one event loop.
 *
 * Usage: node rebuild-worker.mjs <distDir> <home> <indexPath> <barrierEpochMs> [open]
 *
 * With `open`, the worker skips the explicit rebuild and only opens the index,
 * which brings an existing index up to date with the logs.
 */

const [, , dist, home, path, barrierMs, mode] = process.argv

const { SqliteSessionIndex, rebuildSqliteSessionIndex } = await import(
	new URL('store/session-index/index.js', `file://${dist.replace(/\\/g, '/')}/`).href
)

// Released together, past node's variable startup time.
const wait = Number(barrierMs) - Date.now()
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))

const startedAt = Date.now()
const won = mode === 'open' ? false : await rebuildSqliteSessionIndex({ home, path })
const endedAt = Date.now()
const index = await SqliteSessionIndex.open({ home, path })
try {
	const sessions = await index.listSessions()
	let turns = 0
	for (const session of sessions) turns += (await index.listTurns(session.id)).length
	process.stdout.write(
		`${JSON.stringify({ ok: true, sessions: sessions.length, turns, won, startedAt, endedAt })}\n`,
	)
} finally {
	index.close()
}
