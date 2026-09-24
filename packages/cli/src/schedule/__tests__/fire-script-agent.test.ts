/**
 * `runFire` dispatching on `runKind: 'script+agent'`: the wake-gate runs
 * first, on the host, exactly as a pure `script` job's body would; the
 * agent phase — the model, the session, the browser and provider — runs
 * only when the gate says `wake: true`, with its `context` folded into the
 * turn's systemNote as clearly labelled, untrusted text.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hostCommandShell } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetCliLoggerForTests } from '../../logging.js'
import { createAgentSession } from '../../tui/agent.js'
import { runFire } from '../fire/fire.js'
import { readRunResult } from '../fire/result.js'
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
let responses: (() => Response | Promise<Response>)[]
let calls: number
let requestBodies: string[]

beforeEach(() => {
	sb = sandbox()
	responses = []
	calls = 0
	requestBodies = []
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async (_input, init) => {
			calls++
			if (typeof init?.body === 'string') requestBodies.push(init.body)
			const next = responses.shift()
			return next ? next() : completion()
		}),
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
		{ agent: agent(), keepLogging: true, env: { ...process.env, HOME: sb.osHome } },
	)
	return { code, result: readRunResult(sb.paths, job.id, runId) }
}

function scriptAgentJob(gateBody: string, scriptTimeoutMs = 5_000): ScheduleJob {
	return confirmedJob(sb, {
		runKind: 'script+agent',
		script: { body: gateBody, shell: host.dialect, timeoutMs: scriptTimeoutMs },
		permissions: { rules: { bash: 'allow' }, unmatched: 'park' },
	})
}

describe('the wake-gate says no', () => {
	it('ends completed with zero model calls, and records the gate result', async () => {
		const job = scriptAgentJob('echo \'{"wake": false, "context": ""}\'')
		const { code, result } = await fire(job)
		expect(code).toBe(0)
		expect(result?.status).toBe('completed')
		expect(result?.gateResult).toEqual({ wake: false, contextChars: 0 })
		expect(calls).toBe(0)
		expect(result?.sessionId).toBeUndefined()
	})
})

describe('the wake-gate malfunctions', () => {
	it('malformed JSON stdout is check-failed, with a reason, and never calls the model', async () => {
		const job = scriptAgentJob('echo "not json"')
		const { result } = await fire(job)
		expect(result?.status).toBe('check-failed')
		expect(result?.reason).toMatch(/does not end with JSON/)
		expect(calls).toBe(0)
	})

	it('a non-zero exit is check-failed', async () => {
		const job = scriptAgentJob('exit 9')
		const { result } = await fire(job)
		expect(result?.status).toBe('check-failed')
		expect(result?.reason).toMatch(/exited 9/)
		expect(calls).toBe(0)
	})

	it('a timeout is check-failed', async () => {
		const job = scriptAgentJob('sleep 5', 200)
		const { result } = await fire(job)
		expect(result?.status).toBe('check-failed')
		expect(result?.reason).toMatch(/200 ms timeout/)
		expect(calls).toBe(0)
	}, 10_000)
})

describe('the wake-gate says yes', () => {
	it('runs the agent phase, with the context in the systemNote, labelled and untrusted', async () => {
		const job = scriptAgentJob('echo \'{"wake": true, "context": "disk at 95 percent"}\'')
		responses.push(() => completion())
		const { result } = await fire(job)
		expect(result?.status).toBe('completed')
		expect(result?.gateResult).toEqual({ wake: true, contextChars: 'disk at 95 percent'.length })
		expect(calls).toBe(1)
		const body = JSON.parse(requestBodies[0] as string)
		const systemText = JSON.stringify(body)
		expect(systemText).toContain('disk at 95 percent')
		expect(systemText).toContain('untrusted')
	})

	it('never presents the context as job.prompt itself', async () => {
		const job = scriptAgentJob('echo \'{"wake": true, "context": "unique-context-marker-x1"}\'')
		responses.push(() => completion())
		await fire(job)
		const body = JSON.parse(requestBodies[0] as string)
		const messages = (body.messages ?? []) as { role: string; content: unknown }[]
		const userMessage = messages.find((m) => m.role === 'user')
		expect(JSON.stringify(userMessage)).not.toContain('unique-context-marker-x1')
	})
})

describe('the permission-model fix: the gate needs no allow rule, and the two phases are independent', () => {
	it('the gate script runs (and the run reaches the agent phase) with an EMPTY permission set — no bash: allow needed', async () => {
		const job = confirmedJob(sb, {
			runKind: 'script+agent',
			script: {
				body: 'echo \'{"wake": true, "context": "x"}\'',
				shell: host.dialect,
				timeoutMs: 5_000,
			},
			// Deliberately no `bash` rule at all: the old model forced a
			// blanket `bash: allow` here for the gate to pass its own check.
			permissions: { rules: {}, unmatched: 'deny' },
		})
		responses.push(() => completion())
		const { result } = await fire(job)
		expect(result?.gateResult).toEqual({ wake: true, contextChars: 1 })
		expect(result?.status).toBe('completed')
	})

	it('the job’s rules still govern the AGENT phase, unaffected by the gate’s own (deny-only) check: a bash call the rules do not allow is refused, never run', async () => {
		const marker = join(sb.project, 'marker')
		const job = confirmedJob(sb, {
			runKind: 'script+agent',
			script: {
				body: 'echo \'{"wake": true, "context": "x"}\'',
				shell: host.dialect,
				timeoutMs: 5_000,
			},
			// No bash rule for the AGENT phase either: proves the gate's own
			// permissive (deny-only) check never leaks into what the model
			// itself may do once woken.
			permissions: { rules: {}, unmatched: 'deny' },
		})
		responses.push(() => completion({ name: 'bash', input: { command: `touch ${marker}` } }))
		const { result } = await fire(job)
		expect(result?.status).toBe('completed')
		expect(existsSync(marker)).toBe(false)
		expect(result?.refusedCalls?.first.tool).toBe('bash')
	})
})
