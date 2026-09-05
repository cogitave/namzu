import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [, , dist, baseDir, scopeJson, mode, correlationJson = '{}'] = process.argv
const { DiskTokenBudgetStore, openTokenBudget } = await import(
	pathToFileURL(join(dist, 'store/run/token-budget-disk.js')).href
)
const scope = JSON.parse(scopeJson)
const correlation = JSON.parse(correlationJson)
const store = new DiskTokenBudgetStore({ baseDir })
const usage = (tokens) => ({
	promptTokens: tokens,
	completionTokens: 0,
	totalTokens: tokens,
	cachedTokens: 0,
	cacheWriteTokens: 0,
})

if (mode === 'seed-completed' || mode === 'seed-unresolved') {
	const root = await openTokenBudget({ store, scope, limit: 1_000 })
	root.recordUsage(usage(100))
	const child = root.reserve(400)
	child.bindRun(randomUUID())
	const requestId = await child.beginRequest()
	if (mode === 'seed-completed') await child.finishRequest(requestId, usage(150))
	// Leaving the process must not implicitly settle this child or its request.
	process.stdout.write(`${JSON.stringify({ accountId: child.accountId, requestId })}\n`)
} else {
	const root = await openTokenBudget({ store, scope, requireExisting: true })
	const child = root.account(correlation.accountId)
	if (mode === 'settle-completed') {
		await child.finishRequest(correlation.requestId, usage(150))
		child.settle(150)
		child.settle(150)
		await root.flush()
		process.stdout.write(`${JSON.stringify(root.summary())}\n`)
	} else if (mode === 'inspect-unresolved') {
		let admitted = false
		try {
			await root.beginRequest()
			admitted = true
		} catch {}
		process.stdout.write(`${JSON.stringify({ admitted, summary: root.summary(), snapshot: root.snapshot() })}\n`)
	} else {
		throw new Error(`Unknown fixture mode: ${mode}`)
	}
}
