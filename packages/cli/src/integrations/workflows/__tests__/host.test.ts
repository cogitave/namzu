import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { completionNotice } from '../notice.js'
import { TWO_PHASE_SCRIPT, workflowHarness } from './harness.js'

describe('the workflow tool, over the real subagent runtime', () => {
	const open: Awaited<ReturnType<typeof workflowHarness>>[] = []
	afterEach(async () => {
		for (const h of open.splice(0)) {
			await h.close()
			removeTempDir(h.cwd)
		}
	})
	const make = async (options?: Parameters<typeof workflowHarness>[0]) => {
		const h = await workflowHarness(options)
		open.push(h)
		return h
	}

	it('returns at once with text for the model, runs both phases and journals them', async () => {
		const h = await make()
		const result = await h.start({ script: TWO_PHASE_SCRIPT })
		expect(result.success).toBe(true)
		const runId = (result.data as { run_id: string }).run_id
		expect(runId).toMatch(/^w[0-9a-z]{8}$/)
		expect(result.output).toContain(`started in the background as ${runId}`)
		expect(result.output).toContain('/workflows')

		await h.untilEnded()
		const end = h.ended[0]
		expect(end?.view.status).toBe('completed')
		expect(end?.view.agents).toHaveLength(6)
		expect(end?.view.agents.every((agent) => agent.status === 'done')).toBe(true)
		expect(end?.view.phases.map((phase) => phase.title)).toEqual(['Scan', 'Fix'])
		expect(end?.view.result).toEqual({
			found: ['ok:scan 1', 'ok:scan 2', 'ok:scan 3'],
			fixed: ['ok:fix ok:scan 1', 'ok:fix ok:scan 2', 'ok:fix ok:scan 3'],
		})
		// The phase's second wave only started after the first was done.
		expect(h.prompts.filter((p) => p.startsWith('fix'))).toHaveLength(3)

		const journal = h.readJournal(runId)
		expect(journal).toContain('"type":"run_started"')
		expect(journal.match(/"type":"agent_outcome"/g)).toHaveLength(6)
		expect(readFileSync(join(h.runs, runId, 'workflow', 'script.js'), 'utf8')).toBe(
			TWO_PHASE_SCRIPT,
		)
		// The run's turn registration was freed.
		expect(h.released).toHaveLength(1)
	})

	it('files each agent as a real child under the workflow label, never a subagent row', async () => {
		const h = await make()
		const result = await h.start({ script: TWO_PHASE_SCRIPT })
		const runId = (result.data as { run_id: string }).run_id
		await h.untilEnded()
		const children = h.runtime.activity.getSnapshot()
		expect(children).toHaveLength(6)
		for (const child of children) {
			expect(child.workflow).toBe('audit')
			expect(child.workflowId).toBe(`wf:${runId}`)
			expect(['Scan', 'Fix']).toContain(child.phase)
			expect(child.status).toBe('completed')
			// The normal child transcript is there to open.
			expect(child.transcript.some((row) => row.kind === 'assistant')).toBe(true)
		}
		expect(children.filter((c) => c.phase === 'Fix')[0]?.phaseDetail).toBe('safe fixes only')
		// The run knows which row is whose.
		const agent = h.host.registry.get(runId)?.agents[0]
		expect(agent?.viewId).toBeDefined()
		expect(h.host.registry.agentOf(agent?.viewId ?? '')).toEqual({
			runId,
			index: 1,
		})
	})

	it('skips one running agent and stops a whole run', async () => {
		const h = await make({ held: true })
		const result = await h.start({ script: TWO_PHASE_SCRIPT })
		const runId = (result.data as { run_id: string }).run_id
		const agents = () => h.host.registry.get(runId)?.agents ?? []
		await h.until(() => h.gate.waiting() === 3)
		expect(h.host.registry.skipAgent(runId, 1)).toBe(true)
		await h.until(() => agents()[0]?.status === 'skipped')
		// The other two are still running, and the skipped one is not waiting any more.
		await h.until(() => h.gate.waiting() === 2)
		expect(agents().filter((a) => a.status === 'running')).toHaveLength(2)
		h.gate.release()
		h.gate.release()
		// The second phase starts once the first is over; its agents are held too.
		await h.until(() => h.gate.waiting() === 3 && agents().length === 6)
		expect(h.host.registry.stop(runId)).toBe(true)
		await h.untilEnded()
		const view = h.ended[0]?.view
		expect(view?.status).toBe('stopped')
		expect(view?.agents.every((a) => a.status !== 'queued' && a.status !== 'running')).toBe(true)
		expect(view?.agents[0]?.status).toBe('skipped')
		// Stopping is not failing: the agents it cut short are skipped, none failed.
		expect(view?.agents.some((a) => a.status === 'failed')).toBe(false)
		expect(view?.agents.filter((a) => a.status === 'skipped').length).toBeGreaterThan(1)
		expect(h.host.registry.stop(runId)).toBe(false)
		expect(completionNotice(view as never)).toContain('was stopped')
	})

	it('refuses with a plain reason when the turn may not start one', async () => {
		const h = await make({ refusal: 'nobody can approve it' })
		const result = await h.start({ script: TWO_PHASE_SCRIPT })
		expect(result.success).toBe(false)
		expect(result.error).toBe('nobody can approve it')
		expect(h.host.registry.list()).toHaveLength(0)
	})

	it('rejects a script whose meta is not a literal, naming the line', async () => {
		const h = await make()
		const result = await h.start({
			script: "const n = 'x'\nexport const meta = { name: n, description: 'd' }\n",
		})
		expect(result.success).toBe(false)
		expect(result.error ?? '').toMatch(/meta/i)
		expect(h.host.registry.list()).toHaveLength(0)
	})

	it('fails the run, not the session, when the script throws', async () => {
		const h = await make()
		await h.start({
			script:
				"export const meta = { name: 'boom', description: 'throws' }\nthrow new Error('no luck')",
		})
		await h.untilEnded()
		expect(h.ended[0]?.view.status).toBe('failed')
		expect(h.ended[0]?.view.error).toContain('no luck')
	})
})
