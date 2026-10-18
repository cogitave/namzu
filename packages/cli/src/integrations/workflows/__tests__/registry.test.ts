import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileWorkflowJournal, parseWorkflowMeta } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { listWorkflowRuns, readWorkflowRun } from '../history.js'
import { type StartWorkflowRun, type WorkflowRunEnd, WorkflowRunRegistry } from '../registry.js'
import { TWO_PHASE_SCRIPT } from './harness.js'

/** A spawn that answers `ok:<prompt>` once the test lets it, and reports the row it "created". */
function fakeSpawn() {
	const waiting: Array<{ prompt: string; finish: () => void; signal: AbortSignal }> = []
	const spawn: StartWorkflowRun['spawn'] = (request, signal, viewed) =>
		new Promise((resolve, reject) => {
			viewed(`row-${request.index}`)
			const finish = () =>
				resolve({ state: 'done', text: `ok:${request.prompt}`, tokens: 10, toolCalls: 1 })
			waiting.push({ prompt: request.prompt, finish, signal })
			signal.addEventListener('abort', () => reject(signal.reason), { once: true })
			request.onProgress({ tokens: 4, lastToolName: 'read', lastToolSummary: 'Read(a.ts)' })
		})
	return { spawn, waiting }
}

describe('a run in the registry, with a spawn the test controls', () => {
	const dirs: string[] = []
	afterEach(() => {
		for (const dir of dirs.splice(0)) removeTempDir(dir)
	})

	const until = (registry: WorkflowRunRegistry, ready: () => boolean): Promise<void> =>
		ready()
			? Promise.resolve()
			: new Promise((resolve) => {
					const off = registry.subscribe(() => {
						if (!ready()) return
						off()
						resolve()
					})
				})

	function start(registry: WorkflowRunRegistry, spawn: StartWorkflowRun['spawn'], dir?: string) {
		const ended: WorkflowRunEnd[] = []
		const view = registry.start({
			runId: 'wtest0001',
			meta: parseWorkflowMeta(TWO_PHASE_SCRIPT),
			script: TWO_PHASE_SCRIPT,
			spawn,
			...(dir ? { journal: new FileWorkflowJournal(dir) } : {}),
			onEnd: (end) => {
				ended.push(end)
			},
		})
		return { view, ended }
	}

	it('shows the declared phases before an agent exists and returns at once', () => {
		const registry = new WorkflowRunRegistry()
		const { spawn } = fakeSpawn()
		const { view } = start(registry, spawn)
		expect(view.status).toBe('running')
		expect(view.phases.map((p) => p.title)).toEqual(['Scan', 'Fix'])
		expect(view.agents).toEqual([])
		registry.close()
	})

	it('queues, runs, progresses and finishes, and says so once', async () => {
		const registry = new WorkflowRunRegistry()
		const { spawn, waiting } = fakeSpawn()
		const { ended } = start(registry, spawn)
		await until(registry, () => waiting.length === 3)
		const running = registry.get('wtest0001')
		expect(running?.agents.map((a) => [a.label, a.status, a.viewId])).toEqual([
			['scan:1', 'running', 'row-1'],
			['scan:2', 'running', 'row-2'],
			['scan:3', 'running', 'row-3'],
		])
		await until(registry, () => registry.get('wtest0001')?.agents[0]?.lastTool === 'Read(a.ts)')
		expect(registry.agentOf('row-2')).toEqual({ runId: 'wtest0001', index: 2 })
		for (const w of waiting.splice(0)) w.finish()
		await until(registry, () => waiting.length === 3)
		for (const w of waiting.splice(0)) w.finish()
		await until(registry, () => ended.length === 1)
		expect(ended).toHaveLength(1)
		expect(ended[0]?.view).toMatchObject({ status: 'completed' })
		expect(ended[0]?.result?.usage.agents).toBe(6)
		registry.close()
	})

	it('skips one agent while the others go on, then stops the rest', async () => {
		const registry = new WorkflowRunRegistry()
		const { spawn, waiting } = fakeSpawn()
		const { ended } = start(registry, spawn)
		await until(registry, () => waiting.length === 3)
		expect(registry.skipAgent('wtest0001', 2)).toBe(true)
		await until(registry, () => registry.get('wtest0001')?.agents[1]?.status === 'skipped')
		expect(registry.skipAgent('wtest0001', 2)).toBe(false)
		expect(registry.skipAgent('wtest0001', 99)).toBe(false)
		expect(registry.stop('wtest0001')).toBe(true)
		await until(registry, () => ended.length === 1)
		expect(ended[0]?.view.status).toBe('stopped')
		expect(
			ended[0]?.view.agents.every((a) => a.status === 'skipped' || a.status === 'failed'),
		).toBe(true)
		expect(registry.stop('wtest0001')).toBe(false)
		registry.close()
	})

	it('journals the run and reads it back after the registry is gone', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-workflow-journal-'))
		dirs.push(dir)
		const registry = new WorkflowRunRegistry()
		const { spawn, waiting } = fakeSpawn()
		const runDir = join(dir, 'wtest0001', 'workflow')
		const { ended } = start(registry, spawn, runDir)
		for (let wave = 0; wave < 2; wave++) {
			await until(registry, () => waiting.length === 3)
			for (const w of waiting.splice(0)) w.finish()
		}
		await until(registry, () => ended.length === 1)
		registry.close()
		const view = await readWorkflowRun(dir, 'wtest0001')
		expect(view).toMatchObject({ name: 'audit', status: 'completed' })
		expect(view?.agents).toHaveLength(6)
		expect((await listWorkflowRuns(dir)).map((v) => v.runId)).toEqual(['wtest0001'])
	})

	it('survives a torn journal line and ignores directories that are not runs', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-workflow-journal-'))
		dirs.push(dir)
		const registry = new WorkflowRunRegistry()
		const { spawn, waiting } = fakeSpawn()
		const runDir = join(dir, 'wtest0001', 'workflow')
		const { ended } = start(registry, spawn, runDir)
		await until(registry, () => waiting.length === 3)
		registry.stop('wtest0001')
		await until(registry, () => ended.length === 1)
		registry.close()
		writeFileSync(
			join(runDir, 'journal.jsonl'),
			`${(await import('node:fs')).readFileSync(join(runDir, 'journal.jsonl'), 'utf8')}{"type":"log","at":`,
		)
		const listed = await listWorkflowRuns(dir)
		expect(listed).toHaveLength(1)
		expect(await readWorkflowRun(dir, '../etc')).toBeUndefined()
		expect(await listWorkflowRuns(join(dir, 'missing'))).toEqual([])
	})

	it('refuses to start once closed', () => {
		const registry = new WorkflowRunRegistry()
		registry.close()
		expect(() => start(registry, fakeSpawn().spawn)).toThrow(/closed/)
	})

	it('is idle only once the end has been announced, not when the run merely ended', async () => {
		const registry = new WorkflowRunRegistry()
		const { spawn, waiting } = fakeSpawn()
		const announced: string[] = []
		let releaseAnnouncement!: () => void
		const slow = new Promise<void>((resolve) => {
			releaseAnnouncement = resolve
		})
		registry.start({
			runId: 'wtest0001',
			meta: parseWorkflowMeta(TWO_PHASE_SCRIPT),
			script: TWO_PHASE_SCRIPT,
			spawn,
			onEnd: async () => {
				await slow
				announced.push('ended')
			},
		})
		await until(registry, () => waiting.length === 3)
		registry.stop('wtest0001')
		let idle = false
		const waited = registry.whenIdle().then(() => {
			idle = true
		})
		await until(registry, () => registry.get('wtest0001')?.status === 'stopped')
		// Ended, but the announcement is still being made: not idle yet.
		await Promise.resolve()
		expect(idle).toBe(false)
		releaseAnnouncement()
		await waited
		expect(announced).toEqual(['ended'])
		registry.close()
	})

	it('stops waiting when its signal aborts', async () => {
		const registry = new WorkflowRunRegistry()
		const { spawn, waiting } = fakeSpawn()
		registry.start({
			runId: 'wtest0001',
			meta: parseWorkflowMeta(TWO_PHASE_SCRIPT),
			script: TWO_PHASE_SCRIPT,
			spawn,
		})
		await until(registry, () => waiting.length === 3)
		const abort = new AbortController()
		const waited = registry.whenIdle(abort.signal)
		abort.abort()
		await waited
		expect(registry.get('wtest0001')?.status).toBe('running')
		registry.close()
	})
})
