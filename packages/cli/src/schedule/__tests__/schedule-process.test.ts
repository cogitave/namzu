/**
 * Process-level guarantees: an occurrence claim is won by exactly one of many
 * processes, history appends from several processes never tear a line, and a
 * run outlives its daemon being SIGKILLed — its output is a file, not a pipe,
 * so it does not die of EPIPE — and finishes and records its result.
 */

import { type ChildProcess, fork } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readRunResult } from '../fire/result.js'
import { readState } from '../store/state.js'
import { type Sandbox, confirmedJob, sandbox } from './fixtures.js'

const TSX = createRequire(import.meta.url).resolve('tsx')
const CLAIM_WORKER = fileURLToPath(new URL('../__fixtures__/claim-worker.ts', import.meta.url))
const DAEMON_HOST = fileURLToPath(new URL('../__fixtures__/daemon-host.ts', import.meta.url))
const SLOW_FIRE = fileURLToPath(new URL('../__fixtures__/slow-fire.mjs', import.meta.url))

let sb: Sandbox
const children: ChildProcess[] = []
beforeEach(() => {
	sb = sandbox()
})
afterEach(() => {
	for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
	sb.cleanup()
})

function spawnTs(script: string, args: string[]): ChildProcess {
	const child = fork(script, args, {
		execArgv: ['--import', TSX],
		stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
	})
	children.push(child)
	return child
}

it('exactly one of eight processes claims an occurrence; 800 appends from them stay whole', async () => {
	const results = await Promise.all(
		Array.from(
			{ length: 8 },
			(_, i) =>
				new Promise<boolean>((resolve, reject) => {
					const child = spawnTs(CLAIM_WORKER, [
						sb.home,
						'job-1',
						'1790132400000',
						`run-${i}`,
						'100',
					])
					let won = false
					child.on('message', (m) => {
						won = (m as { won: boolean }).won
					})
					child.on('exit', (code) =>
						code === 0 ? resolve(won) : reject(new Error(`exit ${code}`)),
					)
				}),
		),
	)
	expect(results.filter(Boolean)).toHaveLength(1)
	const lines = readFileSync(sb.paths.historyOf('job-1'), 'utf8').trim().split('\n')
	expect(lines).toHaveLength(800)
	for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
}, 60_000)

it('a run survives its daemon being SIGKILLed and records its result', async () => {
	const job = confirmedJob(sb, { when: 'every 1m' }, new Date(Date.now() - 61_000))
	const daemon = spawnTs(DAEMON_HOST, [sb.home, SLOW_FIRE])
	let runId: string | undefined
	for (let i = 0; i < 200 && !runId; i++) {
		await new Promise((r) => setTimeout(r, 50))
		runId = readState(sb.paths, job.id).activeRun?.runId
	}
	expect(runId).toBeDefined()
	await new Promise((r) => setTimeout(r, 250))
	daemon.kill('SIGKILL')
	await new Promise((r) => daemon.once('exit', r))
	for (let i = 0; i < 60; i++) {
		if (readRunResult(sb.paths, job.id, runId as string)?.status === 'completed') break
		await new Promise((r) => setTimeout(r, 100))
	}
	expect(readRunResult(sb.paths, job.id, runId as string)?.status).toBe('completed')
	const log = readFileSync(sb.paths.runLog(job.id, runId as string), 'utf8')
	expect(log).toContain('tick 9')
	expect(existsSync(sb.paths.runResult(job.id, runId as string))).toBe(true)
}, 60_000)
