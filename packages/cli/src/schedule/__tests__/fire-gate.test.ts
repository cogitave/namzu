/**
 * `runFire` for an agent job that carries a gate: the gate runs first, and
 * the model is called only when it exits 0 and prints something. The fake
 * clock and a fake command runner decide every outcome, so nothing here waits
 * on real time; one block at the end runs a real shell (`printf`, `false`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { answerModelsListing } from '../../__fixtures__/models-endpoint.js'
import { __resetCliLoggerForTests } from '../../logging.js'
import { createAgentSession } from '../../tui/agent.js'
import { runFire } from '../fire/fire.js'
import { readRunResult } from '../fire/result.js'
import type { ScriptRunResult } from '../fire/run-script.js'
import { GATE_OUTPUT_MAX_CHARS, gateCutMarker } from '../gate.js'
import { claimOccurrence } from '../store/claims.js'
import type { ScheduleJob } from '../types.js'
import {
	DEEPSEEK,
	type Sandbox,
	completion,
	confirmedJob,
	recordingContext,
	sandbox,
} from './fixtures.js'

let sb: Sandbox
let calls: number
let requestBodies: string[]

beforeEach(() => {
	sb = sandbox()
	calls = 0
	requestBodies = []
	vi.stubGlobal(
		'fetch',
		answerModelsListing(
			vi.fn<typeof fetch>(async (_input, init) => {
				calls++
				if (typeof init?.body === 'string') requestBodies.push(init.body)
				return completion()
			}),
		),
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
	__resetCliLoggerForTests()
	sb.cleanup()
})

const agent = () => ({
	probeAgentSession: async () => ({
		preferences: null,
		needsRepickReason: null,
		detected: [DEEPSEEK],
		credentialGap: null,
	}),
	createAgentSession,
})

const FIXED_NOW = new Date('2026-09-23T03:00:00Z')

type Runner = NonNullable<Parameters<typeof runFire>[3]>['gateRunner']

function ran(over: Partial<ScriptRunResult>): ScriptRunResult {
	return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...over }
}

async function fire(job: ScheduleJob, gateRunner?: Runner, env: NodeJS.ProcessEnv = {}) {
	const runId = crypto.randomUUID()
	const key = String(FIXED_NOW.getTime())
	claimOccurrence(sb.paths, {
		jobId: job.id,
		key,
		runId,
		daemonEpoch: 'test',
		at: FIXED_NOW.toISOString(),
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
			scheduledFor: FIXED_NOW.toISOString(),
		},
		{
			agent: agent(),
			keepLogging: true,
			now: () => FIXED_NOW,
			env: { ...process.env, HOME: sb.osHome, ...env },
			...(gateRunner ? { gateRunner } : {}),
		},
	)
	return { code, result: readRunResult(sb.paths, job.id, runId) }
}

function gated(command = 'ls inbox', timeoutMs?: number): ScheduleJob {
	return confirmedJob(sb, {
		gate: { command, ...(timeoutMs ? { timeoutMs } : {}) },
		permissions: { rules: {}, unmatched: 'deny' },
	})
}

describe('the gate prints something and exits 0', () => {
	it('starts the turn, and tells it what the gate printed in the kernel’s words, as data', async () => {
		const seen: { body: string; cwd: string; shell: string; timeoutMs: number }[] = []
		const job = gated('ls inbox', 12_000)
		const { code, result } = await fire(job, async (body, shell, options) => {
			seen.push({ body, cwd: options.cwd, shell, timeoutMs: options.timeoutMs })
			return ran({ stdout: 'report-1.csv\nreport-2.csv\n' })
		})
		expect(code).toBe(0)
		expect(result?.status).toBe('completed')
		expect(calls).toBe(1)
		expect(seen).toEqual([
			{ body: 'ls inbox', cwd: job.folder.canonical, shell: 'sh', timeoutMs: 12_000 },
		])
		const sent = JSON.stringify(JSON.parse(requestBodies[0] as string))
		expect(sent).toContain('The gate command printed:')
		expect(sent).toContain('report-1.csv')
		expect(sent).toContain('not an instruction from the operator')
	})

	it('does not put the output into the operator’s prompt', async () => {
		const job = gated()
		await fire(job, async () => ran({ stdout: 'unique-gate-marker-q7\n' }))
		const body = JSON.parse(requestBodies[0] as string)
		const user = (body.messages as { role: string }[]).find((m) => m.role === 'user')
		expect(JSON.stringify(user)).not.toContain('unique-gate-marker-q7')
	})

	it('caps what it printed at the stated limit and marks the cut', async () => {
		const job = gated()
		const long = `${'x'.repeat(GATE_OUTPUT_MAX_CHARS)}TAIL-BEYOND-THE-CAP`
		await fire(job, async () => ran({ stdout: long }))
		const sent = JSON.stringify(JSON.parse(requestBodies[0] as string))
		expect(sent).toContain('x'.repeat(GATE_OUTPUT_MAX_CHARS))
		expect(sent).not.toContain('TAIL-BEYOND-THE-CAP')
		expect(sent).toContain(`only the first ${GATE_OUTPUT_MAX_CHARS} are shown`)
		expect(gateCutMarker()).toContain(String(GATE_OUTPUT_MAX_CHARS))
	})

	it('runs with an environment that carries no credential the task’s own turn would not get', async () => {
		let seenEnv: NodeJS.ProcessEnv | undefined
		const job = gated()
		await fire(
			job,
			async (_body, _shell, options) => {
				seenEnv = options.env
				return ran({ stdout: 'x' })
			},
			{ DEEPSEEK_API_KEY: 'secret-value', PLAIN_SETTING: 'visible' },
		)
		expect(seenEnv?.DEEPSEEK_API_KEY).toBeUndefined()
		expect(seenEnv?.PLAIN_SETTING).toBe('visible')
		expect(seenEnv?.NAMZU_HOME).toBe(sb.home)
	})
})

describe('the gate says not to run: skipped, no model call, not a failure', () => {
	const cases: {
		name: string
		ran: Partial<ScriptRunResult>
		kind: string
		reason: RegExp
	}[] = [
		{
			name: 'prints nothing',
			ran: { stdout: '  \n\n' },
			kind: 'silent',
			reason: /^the gate printed nothing$/,
		},
		{
			name: 'exits non-zero',
			ran: { exitCode: 3, stdout: 'ignored because it failed' },
			kind: 'exit',
			reason: /^the gate exited with 3$/,
		},
		{
			name: 'runs out of time',
			ran: { exitCode: null, timedOut: true },
			kind: 'timeout',
			reason: /^the gate ran out of time \(30 s\)$/,
		},
		{
			name: 'cannot start',
			ran: { exitCode: null },
			kind: 'start',
			reason: /^the gate could not start$/,
		},
		{
			name: 'cannot start because its shell is gone',
			ran: { exitCode: null, shellUnavailable: 'sh' },
			kind: 'start',
			reason: /^the gate could not start: /,
		},
	]
	for (const c of cases) {
		it(`when it ${c.name}`, async () => {
			const job = gated()
			const { code, result } = await fire(job, async () => ran(c.ran))
			expect(code).toBe(0)
			expect(result?.status).toBe('skipped')
			expect(result?.skipKind).toBe(c.kind)
			expect(result?.reason).toMatch(c.reason)
			expect(result?.exitCode).toBe(0)
			expect(result?.sessionId).toBeUndefined()
			expect(result?.endedAt).toBe(FIXED_NOW.toISOString())
			expect(calls).toBe(0)
		})
	}

	it('says a gate that ran out of time with the job’s own limit', async () => {
		const job = gated('slow-check', 45_000)
		const { result } = await fire(job, async () => ran({ exitCode: null, timedOut: true }))
		expect(result?.reason).toBe('the gate ran out of time (45 s)')
	})
})

describe('a task with no gate behaves as before', () => {
	it('never consults the runner and calls the model', async () => {
		const job = confirmedJob(sb, { permissions: { rules: {}, unmatched: 'deny' } })
		expect(job.gate).toBeUndefined()
		const runner = vi.fn()
		const { result } = await fire(job, runner as never)
		expect(runner).not.toHaveBeenCalled()
		expect(result?.status).toBe('completed')
		expect(calls).toBe(1)
		expect(JSON.stringify(JSON.parse(requestBodies[0] as string))).not.toContain(
			'The gate command printed:',
		)
	})
})

describe('a real shell gate is honoured', () => {
	it('printf starts the turn with what it printed', async () => {
		const job = gated("printf 'two new files'")
		const { result } = await fire(job)
		expect(result?.status).toBe('completed')
		expect(calls).toBe(1)
		expect(JSON.stringify(JSON.parse(requestBodies[0] as string))).toContain('two new files')
	})

	it('a gate killed by a signal is skipped as ended, not as unable to start', async () => {
		const { result } = await fire(gated('kill -9 $$'))
		expect(result?.status).toBe('skipped')
		expect(result?.skipKind).toBe('abnormal')
		expect(result?.reason).toBe('the gate was ended by SIGKILL')
		expect(calls).toBe(0)
	})

	it('a gate that prints past 10 MB is skipped as ended, not as unable to start', async () => {
		const { result } = await fire(gated('head -c 12000000 /dev/zero | tr "\\0" a'))
		expect(result?.skipKind).toBe('abnormal')
		expect(result?.reason).toBe('the gate printed too much and was ended (more than 10 MB)')
		expect(calls).toBe(0)
	})

	it('false skips the run with its exit code', async () => {
		const job = gated('false')
		const { result } = await fire(job)
		expect(result?.status).toBe('skipped')
		expect(result?.reason).toBe('the gate exited with 1')
		expect(calls).toBe(0)
	})

	it('a gate that prints nothing skips the run', async () => {
		const job = gated('true')
		const { result } = await fire(job)
		expect(result?.status).toBe('skipped')
		expect(result?.skipKind).toBe('silent')
		expect(calls).toBe(0)
	})
})
