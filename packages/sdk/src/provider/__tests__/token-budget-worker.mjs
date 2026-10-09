// One process of the 502 retry trial: it opens the turn's durable token budget, makes one
// scripted model request that either answers 502 or succeeds, and reports what the ledger holds.
import { DiskSessionTokenBudgetStore, SessionPaths, openSessionTokenBudget } from '../../../dist/index.js'
import { withTokenBudget } from '../../../dist/provider/token-budget.js'

const [home, sessionId, turnId, limit, mode] = process.argv.slice(2)
const paths = new SessionPaths({ home, slug: '-proc' })
const budget = await openSessionTokenBudget({
	store: new DiskSessionTokenBudgetStore({ paths }),
	scope: { rootSessionId: sessionId, rootTurnId: turnId },
	limit: Number(limit),
})
const usage = { promptTokens: 40, completionTokens: 0, totalTokens: 40, cachedTokens: 0, cacheWriteTokens: 0 }
const provider = withTokenBudget(
	{
		id: 'scripted',
		name: 'scripted',
		async *chatStream() {
			if (mode === 'fail') throw new Error('502 Bad Gateway')
			yield { id: 'a', delta: { content: 'ok' }, usage, finishReason: 'stop' }
		},
	},
	budget,
)
let outcome = 'answered'
try {
	for await (const _ of provider.chatStream({ model: 'm', messages: [] }));
} catch (error) {
	outcome = error instanceof Error ? error.message : String(error)
}
await budget.flush()
process.stdout.write(`${JSON.stringify({ outcome, summary: budget.summary() })}\n`)
