const [dist, rootDir, tenantRaw, idsRaw, worker, barrierRaw] = process.argv.slice(2)
const {
	DiskSessionGoalStore,
	DiskSessionStore,
	StaleGoalError,
	asSessionId,
	asTenantId,
} = await import(`${dist}/index.js`)

const tenantId = asTenantId(tenantRaw)
const sessionIds = JSON.parse(idsRaw).map(asSessionId)
const sessions = new DiskSessionStore({ rootDir })
const goals = new DiskSessionGoalStore({ rootDir, sessions })
const refs = []
for (const sessionId of sessionIds) {
	const goal = await goals.getGoal(sessionId, tenantId)
	if (!goal) throw new Error(`missing seeded goal for ${sessionId}`)
	refs.push({ sessionId, id: goal.id, revision: goal.revision })
}

const delay = Number(barrierRaw) - Date.now()
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))

const won = []
const unexpected = []
for (const ref of refs) {
	try {
		await goals.admitRound(ref.sessionId, tenantId, {
			id: ref.id,
			revision: ref.revision,
		})
		won.push({ sessionId: ref.sessionId, worker })
	} catch (error) {
		if (!(error instanceof StaleGoalError)) {
			unexpected.push({
				sessionId: ref.sessionId,
				name: error instanceof Error ? error.name : typeof error,
				message: error instanceof Error ? error.message : String(error),
			})
		}
	}
}

process.stdout.write(JSON.stringify({ won, unexpected }))
