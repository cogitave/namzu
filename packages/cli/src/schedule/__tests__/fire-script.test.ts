/**
 * `runFire` dispatching on `runKind: 'script'`: no model, no session, no
 * browser or provider — the same pre-flight checks an agent run already
 * does (job/folder/confirmation/project-digest), then the script itself.
 */

import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostCommandShell } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetCliLoggerForTests } from '../../logging.js'
import { runFire } from '../fire/fire.js'
import { readRunResult } from '../fire/result.js'
import { claimOccurrence } from '../store/claims.js'
import { readJob } from '../store/jobs.js'
import type { ScheduleJob } from '../types.js'
import { type Sandbox, confirmedJob, recordingContext, sandbox } from './fixtures.js'

let sb: Sandbox
beforeEach(() => {
	sb = sandbox()
})
afterEach(() => {
	__resetCliLoggerForTests()
	sb.cleanup()
})

const host = hostCommandShell()
const otherDialect = host.dialect === 'bash' ? 'sh' : 'bash'

async function fire(job: ScheduleJob, runId = crypto.randomUUID()) {
	const key = String(Date.parse('2026-09-23T03:00:00Z'))
	claimOccurrence(sb.paths, {
		jobId: job.id,
		key,
		runId,
		daemonEpoch: 'test',
		at: new Date().toISOString(),
	})
	const code = await runFire(
		recordingContext(),
		sb.paths,
		{
			jobId: job.id,
			runId,
			key,
			revision: job.revision,
			trigger: 'scheduled',
			scheduledFor: '2026-09-23T03:00:00.000Z',
		},
		{ keepLogging: true, env: { ...process.env, HOME: sb.osHome } },
	)
	return { code, result: readRunResult(sb.paths, job.id, runId) }
}

function scriptJob(
	body: string,
	over: {
		readonly shell?: 'bash' | 'sh'
		readonly scriptTimeoutMs?: number
		readonly budgetTimeoutMs?: number
	} = {},
): ScheduleJob {
	return confirmedJob(sb, {
		runKind: 'script',
		script: {
			body,
			shell: over.shell ?? host.dialect,
			timeoutMs: over.scriptTimeoutMs ?? 5_000,
		},
		permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
		...(over.budgetTimeoutMs ? { budget: { timeoutMs: over.budgetTimeoutMs } } : {}),
	})
}

describe('a script job, fired', () => {
	it('completes with its output captured and zero token usage', async () => {
		const job = scriptJob('echo hello')
		const { code, result } = await fire(job)
		expect(code).toBe(0)
		expect(result?.status).toBe('completed')
		expect(result?.scriptOutput?.stdout.trim()).toBe('hello')
		expect(result?.usage).toBeUndefined()
		expect(result?.sessionId).toBeUndefined()
	})

	it('runs in the job’s own folder', async () => {
		const job = scriptJob('pwd')
		const { result } = await fire(job)
		expect(result?.scriptOutput?.stdout.trim()).toBe(job.folder.canonical)
	})

	it('records a non-zero exit as failed, with the exit code', async () => {
		const job = scriptJob('exit 7')
		const { result } = await fire(job)
		expect(result?.status).toBe('failed')
		expect(result?.exitCode).toBe(7)
	})

	it('records its own timeout, separate from the job’s (much longer) budget.timeoutMs', async () => {
		const job = scriptJob('sleep 5', { scriptTimeoutMs: 200, budgetTimeoutMs: 60_000 })
		const { result } = await fire(job)
		expect(result?.status).toBe('timed-out')
		expect(result?.reason).toMatch(/200 ms/)
	}, 10_000)

	it('reuses the shared pre-flight: refuses when the folder was replaced', async () => {
		const job = scriptJob('echo hi')
		const elsewhere = join(sb.osHome, 'elsewhere')
		mkdirSync(elsewhere)
		renameSync(sb.project, `${sb.project}.moved`)
		symlinkSync(elsewhere, sb.project)
		const { result, code } = await fire(job)
		expect(result?.status).toBe('blocked-config')
		expect(code).toBe(77)
	})

	it('reuses the shared pre-flight: a hand-edited script is caught by the digest, not run', async () => {
		const job = scriptJob('echo hi')
		const file = sb.paths.job(job.id)
		const edited = JSON.parse(readFileSync(file, 'utf8'))
		edited.script.body = 'echo tampered'
		writeFileSync(file, JSON.stringify(edited))
		const reread = readJob(sb.paths, job.id) as ScheduleJob
		const { result } = await fire(reread)
		expect(result?.status).toBe('blocked-config')
		expect(result?.reason).toMatch(/changed outside namzu/)
	})

	it('refuses rather than silently switch shells when the host no longer matches the confirmed dialect', async () => {
		const job = scriptJob('echo hi', { shell: otherDialect })
		const { result } = await fire(job)
		expect(result?.status).toBe('blocked-config')
		expect(result?.reason).toMatch(/confirmed for/)
	})
})
