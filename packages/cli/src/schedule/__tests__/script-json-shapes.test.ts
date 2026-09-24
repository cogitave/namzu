/**
 * `schedule show --json`/`history --json` surface a script/script+agent
 * job's runKind, script and (for a fired run) gateResult/scriptOutput —
 * for free, since these commands print the whole typed job/history record;
 * this pins that they still do once daemon.ts writes those fields.
 */

import { hostCommandShell } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetCliLoggerForTests } from '../../logging.js'
import { historyCommand, showCommand } from '../commands/list.js'
import { appendRunRecord } from '../daemon/daemon.js'
import { runFire } from '../fire/fire.js'
import { readRunResult } from '../fire/result.js'
import { claimOccurrence } from '../store/claims.js'
import type { ActiveRun, ScheduleJob } from '../types.js'
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

describe('a script job’s JSON views', () => {
	it('show --json and history --json carry runKind, script and the fired run’s scriptOutput', async () => {
		const job = confirmedJob(sb, {
			runKind: 'script',
			script: { body: 'echo hi', shell: host.dialect, timeoutMs: 5_000 },
			permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
		})
		const runId = crypto.randomUUID()
		const key = String(Date.parse('2026-09-23T03:00:00Z'))
		claimOccurrence(sb.paths, {
			jobId: job.id,
			key,
			runId,
			daemonEpoch: 'test',
			at: new Date().toISOString(),
		})
		await runFire(
			recordingContext(),
			sb.paths,
			{ jobId: job.id, runId, key, revision: job.revision, trigger: 'scheduled' },
			{ keepLogging: true, env: { ...process.env, HOME: sb.osHome } },
		)
		const result = readRunResult(sb.paths, job.id, runId)
		expect(result?.scriptOutput?.stdout.trim()).toBe('hi')
		const run: ActiveRun = {
			runId,
			key,
			trigger: 'scheduled',
			startedAt: result?.startedAt ?? new Date().toISOString(),
			daemonEpoch: 'test',
			status: 'running',
		}
		appendRunRecord(
			sb.paths,
			job.id,
			run,
			result as NonNullable<typeof result>,
			new Date().toISOString(),
		)

		const showCtx = recordingContext()
		await showCommand(showCtx, [job.name, '--home', sb.home, '--json'])
		const shown = JSON.parse(String(showCtx.out.printed[0])) as { job: ScheduleJob }
		expect(shown.job.runKind).toBe('script')
		expect(shown.job.script).toMatchObject({ body: 'echo hi', shell: host.dialect })

		const historyCtx = recordingContext()
		await historyCommand(historyCtx, [job.name, '--home', sb.home, '--json'])
		const history = JSON.parse(String(historyCtx.out.printed[0])) as {
			records: { kind: string; scriptOutput?: { stdout: string } }[]
		}
		const runRecord = history.records.find((r) => r.kind === 'run')
		expect(runRecord?.scriptOutput?.stdout.trim()).toBe('hi')
	})
})
