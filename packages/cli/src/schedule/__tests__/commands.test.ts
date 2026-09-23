/**
 * `namzu schedule` verbs as a script meets them: without a terminal nothing
 * is confirmed, a job needs an explicit permission set, and the `--json`
 * shapes are the documented ones.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addCommand, confirmCommand } from '../commands/add.js'
import { pauseCommand, pruneCommand, removeCommand } from '../commands/lifecycle.js'
import { historyCommand, listCommand } from '../commands/list.js'
import { findJob, readJob } from '../store/jobs.js'
import { type Sandbox, confirmedJob, recordingContext, sandbox } from './fixtures.js'

let sb: Sandbox
beforeEach(() => {
	sb = sandbox()
})
afterEach(() => sb.cleanup())

const base = (sb: Sandbox) => [
	'nightly',
	'--home',
	sb.home,
	'--prompt',
	'Check deps',
	'--when',
	'0 3 * * *',
	'--tz',
	'UTC',
	'--folder',
	sb.project,
	'--model',
	'deepseek/deepseek-chat',
]

describe('schedule add without a terminal', () => {
	it('refuses without --permissions (64)', async () => {
		const ctx = recordingContext()
		expect(await addCommand(ctx, base(sb))).toBe(64)
		expect(ctx.out.errors.join(' ')).toMatch(/--permissions is required/)
	})

	it('refuses without --yes (64), and with --yes creates the job inert', async () => {
		const ctx = recordingContext()
		expect(await addCommand(ctx, [...base(sb), '--permissions', 'read-only'])).toBe(64)
		expect(ctx.out.errors.join(' ')).toMatch(/no terminal/)
		expect(
			await addCommand(recordingContext(), [...base(sb), '--permissions', 'read-only', '--yes']),
		).toBe(0)
		const job = findJob(sb.paths, 'nightly')
		expect(job.state).toBe('pending-confirmation')
		expect(job.confirmation).toBeNull()
		expect(job.trust).toBeNull()
	})

	it('shows the next three fire times in the job zone before anything is written', async () => {
		const ctx = recordingContext()
		await addCommand(ctx, [...base(sb), '--permissions', 'read-only', '--yes'])
		const preview = ctx.out.info.join('\n')
		expect(preview).toMatch(/When {8}at 03:00 every day \(UTC\)/)
		expect(preview.match(/03:00/g)?.length).toBeGreaterThanOrEqual(3)
		expect(preview).toContain('Ceiling')
	})

	it('confirm refuses without a terminal', async () => {
		await addCommand(recordingContext(), [...base(sb), '--permissions', 'read-only', '--yes'])
		const ctx = recordingContext()
		expect(await confirmCommand(ctx, ['nightly', '--home', sb.home])).toBe(64)
		expect(findJob(sb.paths, 'nightly').state).toBe('pending-confirmation')
	})
})

describe('reading and changing jobs', () => {
	it('list --json and history --json print the documented shapes', async () => {
		const job = confirmedJob(sb)
		const ctx = recordingContext()
		expect(await listCommand(ctx, ['--home', sb.home, '--json'])).toBe(0)
		const listed = JSON.parse(String(ctx.out.printed[0]))
		expect(listed).toMatchObject({
			v: 1,
			jobs: [{ id: job.id, name: 'nightly', state: 'active', tz: 'UTC' }],
		})
		const history = recordingContext()
		await historyCommand(history, ['nightly', '--home', sb.home, '--json'])
		expect(JSON.parse(String(history.out.printed[0]))).toMatchObject({
			v: 1,
			job: { id: job.id },
			records: [],
		})
	})

	it('pause and resume go through the CLI path and keep the confirmation', async () => {
		const job = confirmedJob(sb)
		expect(await pauseCommand(recordingContext(), ['nightly', '--home', sb.home])).toBe(0)
		expect(readJob(sb.paths, job.id)?.state).toBe('paused')
		expect(await pauseCommand(recordingContext(), ['nightly', '--home', sb.home], true)).toBe(0)
		expect(readJob(sb.paths, job.id)?.state).toBe('active')
	})

	it('remove without a terminal needs --yes', async () => {
		const job = confirmedJob(sb)
		expect(await removeCommand(recordingContext(), ['nightly', '--home', sb.home])).toBe(64)
		expect(await removeCommand(recordingContext(), ['nightly', '--home', sb.home, '--yes'])).toBe(0)
		expect(readJob(sb.paths, job.id)).toBeUndefined()
	})
})

describe('prune', () => {
	it('reaches a removed job’s run files and, once they are gone, its history', async () => {
		const { mkdirSync, writeFileSync, existsSync, utimesSync } = await import('node:fs')
		const { appendHistory } = await import('../store/history.js')
		const { writeRunResult } = await import('../fire/result.js')
		const kept = confirmedJob(sb, { name: 'kept' })
		const gone = confirmedJob(sb, { name: 'gone' })
		const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
		for (const job of [kept, gone]) {
			appendHistory(sb.paths, job.id, {
				v: 1,
				kind: 'run',
				at: old,
				runId: `run-${job.name}`,
				key: '1',
				trigger: 'scheduled',
				startedAt: old,
				endedAt: old,
				status: 'completed',
			})
			writeRunResult(sb.paths, {
				v: 1,
				kind: 'schedule-run-result',
				runId: `run-${job.name}`,
				jobId: job.id,
				status: 'completed',
				exitCode: 0,
				startedAt: old,
				endedAt: old,
			})
		}
		// A run file history never named, old enough to go.
		mkdirSync(sb.paths.runsOf(gone.id), { recursive: true })
		writeFileSync(sb.paths.runLog(gone.id, 'orphan'), 'x')
		const then = new Date(Date.now() - 40 * 86_400_000)
		utimesSync(sb.paths.runLog(gone.id, 'orphan'), then, then)
		expect(await removeCommand(recordingContext(), ['gone', '--home', sb.home, '--yes'])).toBe(0)

		const dry = recordingContext()
		expect(await pruneCommand(dry, ['--home', sb.home])).toBe(0)
		expect(String(dry.out.printed[0])).toMatch(/removed job .* run run-gone/)
		expect(String(dry.out.printed[0])).toMatch(/removed job .* run orphan/)

		expect(await pruneCommand(recordingContext(), ['--home', sb.home, '--delete', '--yes'])).toBe(0)
		expect(existsSync(sb.paths.runsOf(gone.id))).toBe(false)
		expect(existsSync(sb.paths.historyOf(gone.id))).toBe(false)
		expect(existsSync(sb.paths.runResult(kept.id, 'run-kept'))).toBe(false)
		expect(existsSync(sb.paths.historyOf(kept.id))).toBe(true)
	})
})
