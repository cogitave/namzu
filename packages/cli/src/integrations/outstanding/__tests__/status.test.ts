import { afterEach, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { workflowHarness } from '../../workflows/__tests__/harness.js'
import { collectOutstanding } from '../collect.js'
import { outstandingLines } from '../note.js'

const open: Awaited<ReturnType<typeof workflowHarness>>[] = []
afterEach(async () => {
	for (const h of open.splice(0)) {
		h.gate.open()
		await h.close()
		removeTempDir(h.cwd)
	}
})

const SCRIPT = `export const meta = { name: 'audit', description: 'Read-only greetings', phases: [{ title: 'Greet' }, { title: 'Wrap' }] }
phase('Greet')
log('greeting everyone')
const first = await parallel([1, 2].map(n => () => agent('Return a greeting, no tools.', { label: 'greeting-' + n, phase: 'Greet' })))
phase('Wrap')
return first`

async function started() {
	const h = await workflowHarness({ held: true })
	open.push(h)
	await h.start({ script: SCRIPT })
	await h.until(() => h.gate.waiting() === 2)
	return h
}

const digits = (text: string): string => text.replace(/\d+/g, 'N')

it('reads a running workflow: phase, counts, log lines, elapsed time and no estimate', async () => {
	const h = await started()
	const read = JSON.parse((await h.runtime.agentTaskListTool.execute({}, h.context)).output)
	expect(read.workflows).toHaveLength(1)
	const run = read.workflows[0]
	expect(run).toMatchObject({
		name: 'audit',
		status: 'running',
		phase: { index: 1, of: 2, title: 'Greet' },
		agents: { total: 2, done: 0, running: 2, queued: 0, failed: 0 },
	})
	expect(typeof run.elapsed_ms).toBe('number')
	expect(run.running_agents.map((a: { label: string }) => a.label).sort()).toEqual([
		'greeting-1',
		'greeting-2',
	])
	expect(run.observed).toContain('log: greeting everyone')
	expect(run.observed).toContain('kind="workflow-status"')
	expect(run.note).toContain('No estimate')
	expect(JSON.stringify(read)).not.toMatch(/\beta\b|remaining_ms|ends_at/i)
})

it('returns, in the listing, the same lines the request note carries', async () => {
	const h = await started()
	const read = JSON.parse((await h.runtime.agentTaskListTool.execute({}, h.context)).output)
	const note = outstandingLines(
		collectOutstanding({
			now: Date.now(),
			jobs: [],
			agents: h.runtime.activity.getSnapshot(),
			workflows: h.host.registry.list(),
		}),
	)
	expect(read.outstanding.map(digits)).toEqual(note.map(digits))
	expect(read.outstanding[0]).toMatch(/^workflow w[0-9a-z]{8} "audit" - /)
	expect(read.outstanding[0]).toContain('phase 1/2 "Greet", 2 running, 0 queued, 0 done')
})

it('quotes what a finished agent answered as data and selects one run', async () => {
	const h = await started()
	const runId = h.host.registry.list()[0]?.runId as string
	h.gate.release()
	await h.until(() => h.host.registry.list()[0]?.agents.some((a) => a.status === 'done') === true)
	const one = JSON.parse(
		(await h.runtime.agentTaskListTool.execute({ run_id: runId }, h.context)).output,
	)
	expect(one.tasks).toEqual([])
	expect(one.workflows).toHaveLength(1)
	expect(one.workflows[0].agents).toMatchObject({ done: 1, running: 1 })
	expect(one.workflows[0].observed).toMatch(/done: greeting-\d: ok:Return a greeting/)
	const other = JSON.parse(
		(await h.runtime.agentTaskListTool.execute({ run_id: 'wzzzzzzzz' }, h.context)).output,
	)
	expect(other.workflows).toEqual([])
})

it('says an ended run has ended and does not repeat its result', async () => {
	const h = await started()
	h.gate.open()
	await h.untilEnded()
	const read = JSON.parse((await h.runtime.agentTaskListTool.execute({}, h.context)).output)
	expect(read.workflows[0]).toMatchObject({ status: 'completed' })
	expect(read.workflows[0].note).toContain('completion message')
	expect(read.outstanding).toEqual([])
})

it('gives a workflow task id the pointer to the status read, not a wait', async () => {
	const h = await started()
	const runId = h.host.registry.list()[0]?.runId as string
	const waited = await h.runtime.waitForTaskTool.execute({ task_id: runId }, h.context)
	expect(waited.output).toContain(`agent_task_list with run_id ${runId}`)
})
