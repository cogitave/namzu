import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { FileWorkflowJournal } from '../journal.js'
import { loadWorkflowResume } from '../resume.js'
import { META, makeHost, runScript } from './host.js'

/**
 * A workflow run whose process is killed (SIGKILL, no chance to clean up)
 * resumes from what reached the disk: the agents that finished return their
 * saved results, the one that was in flight and everything after it run.
 *
 * The child finishes its first agent, then starts the second and holds it
 * forever. It says it is ready only once the journal has taken the first
 * agent's saved result, so the parent knows what is on disk. The parent waits
 * for that line on the child's output and for the child's exit event, never
 * for a clock.
 */

const DIST = join(import.meta.dirname, '../../../../dist/execution/workflow/index.js')
const RUN = 'wkilled001'
const SCRIPT = `${META}return [await agent('first'), await agent('second'), await agent('third')]`

const made: string[] = []
afterEach(async () => {
	await removeTempDirs(made.splice(0))
})

function killedRun(dir: string): Promise<void> {
	const script = `
		const { FileWorkflowJournal, WorkflowRuntime } = await import(${JSON.stringify(DIST)})
		const file = new FileWorkflowJournal(${JSON.stringify(dir)}, { runId: ${JSON.stringify(RUN)} })
		let saved
		const firstSaved = new Promise((resolve) => { saved = resolve })
		const journal = {
			writeScript: (...args) => file.writeScript(...args),
			append: async (record) => {
				await file.append(record)
				if (record.type === 'agent_outcome' && record.index === 1) saved()
			},
		}
		setInterval(() => {}, 1 << 30)
		await new WorkflowRuntime().run({
			script: ${JSON.stringify(SCRIPT)},
			runId: ${JSON.stringify(RUN)},
			journal,
			deterministic: true,
			spawnAgent: async (request) => {
				if (request.prompt === 'second') {
					await firstSaved
					process.stdout.write('ready\\n')
					await new Promise(() => {})
				}
				return { state: 'done', text: 'ok:' + request.prompt, tokens: 1, toolCalls: 0 }
			},
		})
	`
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let err = ''
		child.stderr.on('data', (chunk) => {
			err += chunk
		})
		child.on('error', reject)
		child.stdout.on('data', (chunk) => {
			if (String(chunk).includes('ready')) child.kill('SIGKILL')
		})
		child.on('exit', (_code, signal) => {
			if (signal === 'SIGKILL') resolve()
			else reject(new Error(`the run ended without being killed: ${err}`))
		})
	})
}

it('resumes a run whose process was killed, running only the agent that was in flight and the one after it', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'wf-kill-'))
	made.push(dir)
	await killedRun(dir)

	const journal = new FileWorkflowJournal(dir, { runId: RUN })
	const checked = await journal.read()
	expect(checked.brokenAt).toBeUndefined()
	expect(checked.records.some((record) => record.type === 'run_finished')).toBe(false)
	const state = loadWorkflowResume(checked)
	expect(state.resumable).toBe(true)
	expect(state.results.size).toBe(1)

	const calls: string[] = []
	const host = makeHost()
	const spawnAgent = host.spawnAgent
	host.spawnAgent = async (request, signal) => {
		calls.push(request.prompt)
		return spawnAgent(request, signal)
	}
	const { result } = await runScript(SCRIPT, {
		host,
		runId: RUN,
		journal: new FileWorkflowJournal(dir, { runId: RUN }),
		resume: state,
		deterministic: true,
	})
	expect(calls).toEqual(['second', 'third'])
	expect(result.status).toBe('completed')
	expect(result.usage.cachedAgents).toBe(1)
	const after = await new FileWorkflowJournal(dir, { runId: RUN }).read()
	expect(after.brokenAt).toBeUndefined()
	expect(after.records.at(-1)?.type).toBe('run_finished')
})
