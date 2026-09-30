// Observe existing public contracts. This is research evidence, not a workflow executor.
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskTaskStore,
	PlanManager,
	SessionPaths,
	generateSessionId,
	generateTurnId,
} from '../../packages/sdk/dist/index.js'

const sessionId = generateSessionId()
const turnId = generateTurnId()
const scope = { sessionId, turnId }
const plan = new PlanManager(scope)
plan.startGenerating('Existing orchestration boundary')
plan.addStep({ id: 'A', description: 'Produce input', dependsOn: [], order: 0 })
plan.addStep({ id: 'B', description: 'Consume input', dependsOn: ['A'], order: 1 })
plan.markReady()
plan.approve()
plan.startExecution()
const readyBefore = plan.getNextPendingStep()?.id
// This public update reports state; it is not a guarded dependency admission.
plan.updateStepStatus('B', 'running')
const statusesAfterDirectUpdate = plan.active.steps.map(({ id, status }) => ({ id, status }))
const reopenedPlan = new PlanManager(scope)

const home = await mkdtemp(join(tmpdir(), 'namzu-orchestration-boundary-'))
const paths = new SessionPaths({ home, slug: '-research' })
const open = () => new DiskTaskStore({ paths, session: { sessionId } })
const tasks = open()
const upstream = await tasks.create({ ...scope, subject: 'Produce input' })
const downstream = await tasks.create({
	...scope,
	subject: 'Consume input',
	blockedBy: [upstream.id],
})
await tasks.claim(downstream.id, 'research-worker')
const persistedDownstream = await open().get(downstream.id)
const persistedUpstream = await open().get(upstream.id)

const observation = {
	modelCalls: 0,
	userJobsChanged: false,
	plan: {
		readyBefore,
		statusesAfterDirectUpdate,
		freshManagerHasActivePlan: reopenedPlan.active !== null,
	},
	taskStore: {
		upstreamStatus: persistedUpstream.status,
		downstreamStatus: persistedDownstream.status,
		dependencyRetained: persistedDownstream.blockedBy.includes(upstream.id),
		owner: persistedDownstream.owner,
	},
	interpretation:
		'Existing dependency helpers and persisted tasks are usable primitives. Direct status update/claim do not supply workflow admission or automatic plan restoration.',
}
await writeFile(
	new URL('./artifacts/orchestration-boundary.json', import.meta.url),
	`${JSON.stringify(observation, null, 2)}\n`,
)
console.log(JSON.stringify({ ...observation, temporaryState: home }))
