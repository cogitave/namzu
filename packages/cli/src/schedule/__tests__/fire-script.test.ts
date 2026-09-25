/**
 * `runFire` dispatching on `runKind: 'script'`: no model, no session, no
 * browser or provider — the same pre-flight checks an agent run already
 * does (job/folder/confirmation/project-digest), then the script itself.
 */

import {
	mkdirSync,
	readFileSync,
	renameSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { hostCommandShell, installedCommandShellForDialect } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetCliLoggerForTests } from '../../logging.js'
import { confirmJob } from '../build.js'
import { runFire } from '../fire/fire.js'
import { readRunResult } from '../fire/result.js'
import { claimOccurrence } from '../store/claims.js'
import { readJob, updateJob } from '../store/jobs.js'
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
		const job = scriptJob('sleep 5', {
			scriptTimeoutMs: 200,
			budgetTimeoutMs: 60_000,
		})
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

	it('refuses an unknown run kind or a missing script before executing anything', async () => {
		for (const malformed of ['unknown-kind', 'missing-script'] as const) {
			const original = confirmedJob(sb, {
				name: malformed,
				runKind: 'script',
				script: { body: 'echo should-not-run', shell: host.dialect },
				permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
			})
			const changed = updateJob(sb.paths, original.id, original.revision, (job) => {
				const altered =
					malformed === 'unknown-kind'
						? { ...job, runKind: 'other' as ScheduleJob['runKind'] }
						: { ...job, script: undefined }
				return confirmJob(altered, 'cli-tty', new Date())
			})
			const { result } = await fire(changed)
			expect(result?.status, malformed).toBe('blocked-config')
			expect(result?.scriptOutput, malformed).toBeUndefined()
			expect(result?.reason, malformed).toMatch(
				malformed === 'unknown-kind' ? /unknown run kind/ : /has no script recorded/,
			)
		}
	})

	it('refuses a modeled run missing its stored model before its agent or wake-gate starts', async () => {
		for (const runKind of ['agent', 'script+agent'] as const) {
			const original = confirmedJob(sb, {
				name: `missing-model-${runKind.replace('+', '-')}`,
				runKind,
				...(runKind === 'script+agent'
					? { script: { body: 'echo should-not-run', shell: host.dialect } }
					: {}),
			})
			const changed = updateJob(sb.paths, original.id, original.revision, (job) =>
				confirmJob({ ...job, model: undefined }, 'cli-tty', new Date()),
			)
			const { result } = await fire(changed)
			expect(result?.status, runKind).toBe('blocked-config')
			expect(result?.reason, runKind).toMatch(/agent job has no model/)
			expect(result?.scriptOutput, runKind).toBeUndefined()
		}
	})

	it('re-verifies the script against config-file deny rules ADDED after confirmation (not covered by the digest)', async () => {
		const job = scriptJob('curl http://example.test/x')
		writeFileSync(join(sb.home, 'config.yaml'), 'permissions:\n  bash:\n    "curl*": deny\n')
		const { result } = await fire(job)
		expect(result?.status).toBe('blocked-config')
		expect(result?.reason).toMatch(/no longer allowed/)
		expect(result?.reason).toContain('curl')
	})

	it.skipIf(process.platform === 'win32' || !installedCommandShellForDialect('sh'))(
		'runs a confirmed sh script under sh even when the host bash tool chooses bash',
		async () => {
			const selected = installedCommandShellForDialect('sh')
			const job = scriptJob('printf "%s" "$0"', { shell: 'sh' })
			const { result } = await fire(job)
			expect(result?.status).toBe('completed')
			expect(result?.scriptOutput?.stdout).toBe(selected?.path)
		},
	)

	it.skipIf(process.platform === 'win32' || !installedCommandShellForDialect('bash'))(
		'blocks a confirmed job when its selected interpreter was removed before fire',
		async () => {
			const executable = installedCommandShellForDialect('bash')?.path as string
			const custom = join(sb.root, 'bash')
			const previous = process.env.NAMZU_BASH_SHELL
			symlinkSync(executable, custom)
			try {
				process.env.NAMZU_BASH_SHELL = custom
				const job = scriptJob('echo should-not-run', { shell: 'bash' })
				unlinkSync(custom)
				const { result } = await fire(job)
				expect(result?.status).toBe('blocked-config')
				expect(result?.reason).toMatch(/requested bash shell is not executable/)
				expect(result?.scriptOutput).toBeUndefined()
			} finally {
				if (previous === undefined) delete process.env.NAMZU_BASH_SHELL
				else process.env.NAMZU_BASH_SHELL = previous
			}
		},
	)

	it('refuses to run on native Windows at fire time, even though the job was confirmed elsewhere (WSL/Linux)', async () => {
		// The job was confirmed with an installed POSIX shell. Native Windows
		// must refuse before interpreter lookup or the script's static check:
		// Node's cmd.exe cannot be verified with either POSIX dialect.
		// Job creation itself already refuses this on native Windows
		// (`build.ts`); this proves `__fire` refuses it independently too,
		// for a job that was already confirmed before the platform changed
		// (a moved NAMZU_HOME, a machine re-imaged from WSL to native).
		const job = scriptJob('echo hi', { shell: host.dialect })
		const real = process.platform
		Object.defineProperty(process, 'platform', {
			value: 'win32',
			configurable: true,
		})
		try {
			const { result } = await fire(job)
			expect(result?.status).toBe('blocked-config')
			expect(result?.reason).toMatch(/native Windows/)
		} finally {
			Object.defineProperty(process, 'platform', { value: real })
		}
	})
})
