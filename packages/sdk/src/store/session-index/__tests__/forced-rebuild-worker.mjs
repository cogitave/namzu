/**
 * A process that force-rebuilds the session index at a path, so the test can
 * replace the file under a connection another process holds open.
 *
 * Usage: node forced-rebuild-worker.mjs <distDir> <home> <indexPath>
 */
const [, , dist, home, path] = process.argv

const { rebuildSqliteSessionIndex } = await import(
	new URL('store/session-index/index.js', `file://${dist.replace(/\\/g, '/')}/`).href
)
const replaced = await rebuildSqliteSessionIndex({ home, path, force: true })
process.stdout.write(`${JSON.stringify({ replaced })}\n`)
