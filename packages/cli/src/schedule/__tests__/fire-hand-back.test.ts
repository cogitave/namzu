/**
 * A scheduled run whose model hands the task back to a person: the run ends
 * as `needs-a-person`, records what the model said, and is surfaced the way a
 * failing run is (the failure streak, one notice per cause). Through the real
 * session and kernel with the provider's wire stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { answerModelsListing } from '../../__fixtures__/models-endpoint.js'
import { __resetCliLoggerForTests } from '../../logging.js'
import { createAgentSession } from '../../tui/agent.js'
import { noticeText } from '../daemon/notify.js'
import { runFire } from '../fire/fire.js'
import { readRunResult } from '../fire/result.js'
import { claimOccurrence } from '../store/claims.js'
import type { ScheduleJob } from '../types.js'
import { runResultVersion } from '../types.js'
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

beforeEach(() => {
	sb = sandbox()
	responses = []
	calls = 0
	vi.stubGlobal(
		'fetch',
		answerModelsListing(
			vi.fn<typeof fetch>(async () => {
				calls++
				const next = responses.shift()
				return next ? await next() : completion()
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

const HAND_BACK = {
	kind: 'decision',
	blocker: 'two release channels fit and only the owner can choose',
	tried: 'compared both',
	needed: 'say which channel to use',
}

/** The real session, with the setting on, as `handBack.enabled` would make it. */
const agentWith = (handBack: boolean) => ({
	probeAgentSession: async () => ({
		preferences: null,
		needsRepickReason: null,
		detected: [DEEPSEEK],
		credentialGap: null,
	}),
	createAgentSession: ((prefs, detected, options) =>
		createAgentSession(prefs, detected, {
			...options,
			...(handBack ? { handBack: true } : {}),
		})) as typeof createAgentSession,
})

async function fire(job: ScheduleJob, handBack: boolean) {
	const runId = crypto.randomUUID()
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
		{ agent: agentWith(handBack), keepLogging: true, env: { HOME: sb.osHome } },
	)
	return { code, result: readRunResult(sb.paths, job.id, runId) }
}

describe('a scheduled run the model handed back', () => {
	it('ends as needs-a-person, with the model’s words kept as the model’s, after one model call', async () => {
		responses.push(() => completion({ name: 'hand_back_task', input: HAND_BACK }))
		const { code, result } = await fire(confirmedJob(sb), true)
		expect(calls).toBe(1)
		expect(code).toBe(1)
		expect(result?.status).toBe('needs-a-person')
		expect(result?.handedBack).toEqual(HAND_BACK)
		expect(result?.reason).toContain(
			'The model handed the task back to a person: a decision is needed that belongs to a person.',
		)
		expect(result?.reason).toContain('The model said: two release channels fit')
		expect(result?.v).toBe(2)
	})

	it('is not handed back when the setting is off: the tool is not there', async () => {
		responses.push(() => completion({ name: 'hand_back_task', input: HAND_BACK }))
		const { result } = await fire(confirmedJob(sb), false)
		expect(result?.status).toBe('completed')
		expect(result?.handedBack).toBeUndefined()
	})
})

describe('how a run that needs a person is surfaced', () => {
	const job = { name: 'nightly', notify: { includeSummary: false } } as never

	it('says so without the model’s words unless the job asked for its summary', () => {
		const quiet = noticeText('needs-a-person', job, {
			at: new Date('2026-09-23T03:00:00Z'),
			reason: 'The model said: a secret',
		})
		expect(quiet.body).toContain('needs a person')
		expect(quiet.body).not.toContain('secret')
		const loud = noticeText(
			'needs-a-person',
			{ ...(job as object), notify: { includeSummary: true } } as never,
			{ at: new Date('2026-09-23T03:00:00Z'), reason: 'The model said: a decision' },
		)
		expect(loud.body).toContain('a decision')
	})

	it('is a result an older reader of status v1 does not get: it writes version 2', () => {
		expect(runResultVersion({ status: 'needs-a-person' })).toBe(2)
		expect(runResultVersion({ status: 'completed' })).toBe(1)
	})
})
