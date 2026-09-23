/**
 * A scheduled run with a browser grant: refused before any model call when
 * its browser cannot start, and otherwise given the browser the grant
 * describes — the job's profile, unattended, no window, held to the job's
 * sites with every other site denied.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetCliLoggerForTests } from '../../logging.js'
import { createAgentSession } from '../../tui/agent.js'
import { CHILD_ENV_ALLOWLIST } from '../env.js'
import { handoffReason, runFire } from '../fire/fire.js'
import { readRunResult } from '../fire/result.js'
import { localTimeText, unattendedNote } from '../fire/unattended-note.js'
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

beforeEach(() => {
	sb = sandbox()
	calls = 0
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async () => {
			calls++
			return completion()
		}),
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
	__resetCliLoggerForTests()
	sb.cleanup()
})

const seen: Parameters<typeof createAgentSession>[2][] = []
const agent = {
	probeAgentSession: async () => ({
		preferences: null,
		needsRepickReason: null,
		detected: [DEEPSEEK],
		credentialGap: null,
	}),
	createAgentSession: ((prefs, detected, options) => {
		seen.push(options)
		return createAgentSession(prefs, detected, options)
	}) as typeof createAgentSession,
}

function browserJob(): ScheduleJob {
	return confirmedJob(sb, {
		permissions: {
			preset: 'read-only',
			unmatched: 'park',
			browser: { profile: 'social', sites: { 'http://localhost:8123': 'act' } },
		},
	})
}

async function fire(job: ScheduleJob, extra: Parameters<typeof runFire>[3] = {}) {
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
		{ jobId: job.id, runId, key, revision: job.revision, trigger: 'scheduled' },
		{ agent, keepLogging: true, env: { HOME: sb.osHome }, ...extra },
	)
	return { code, result: readRunResult(sb.paths, job.id, runId) }
}

describe('a scheduled run with a browser grant', () => {
	it('is blocked before the model when its profile does not exist', async () => {
		seen.length = 0
		const { result } = await fire(browserJob())
		expect(result?.status).toBe('blocked-config')
		expect(result?.reason).toMatch(
			/browser profile social does not exist; sign in once with namzu browser login social/,
		)
		expect(calls).toBe(0)
		expect(seen).toHaveLength(0)
	})

	it('drives the job’s profile, unattended, with no window, on the job’s sites only', async () => {
		seen.length = 0
		writeFileSync(
			join(sb.home, 'config.yaml'),
			'browser:\n  sites:\n    "https://blocked.example": deny\n',
		)
		const { result } = await fire(browserJob(), {
			browserPreflight: async () => ({ ok: true, engine: 'windows', warnings: [] }),
		})
		expect(result?.status).toBe('completed')
		expect(seen[0]?.browser).toEqual({
			profile: 'social',
			engine: 'windows',
			headless: 'always',
			sites: {
				'http://localhost:8123': 'act',
				'https://blocked.example': 'deny',
				'*': 'deny',
			},
			home: sb.home,
			mode: 'unattended',
		})
	})

	it('gives a job without a grant no browser at all', async () => {
		seen.length = 0
		const { result } = await fire(confirmedJob(sb))
		expect(result?.status).toBe('completed')
		expect(seen[0]?.browser).toBeUndefined()
	})
})

describe('what a scheduled run is told', () => {
	it('says a page that needs a person stops the run, when the job has the browser', () => {
		expect(unattendedNote('post', { browser: true })).toMatch(
			/run stops there and the operator is told; do not try to get past it, never type a password/,
		)
		expect(unattendedNote('post')).not.toMatch(/browser/)
	})
})

describe('what a parked browser run says it needs', () => {
	it('names the sign-in command with the page’s reason', () => {
		expect(
			handoffReason({
				reason: 'http://localhost:8123 is showing a sign-in page',
				detail: {
					tool: 'browser',
					loginCommand: 'namzu browser login social http://localhost:8123/login',
				},
			}),
		).toBe(
			'http://localhost:8123 is showing a sign-in page; sign in again with namzu browser login social http://localhost:8123/login',
		)
		expect(handoffReason({ reason: 'Approve on your phone' })).toBe('Approve on your phone')
	})
})

describe('the time a scheduled run is told', () => {
	it('is the local time with its zone, not a date alone', () => {
		const at = new Date('2026-09-23T18:04:00Z')
		expect(localTimeText(at, 'Europe/Istanbul')).toBe(
			'Wednesday, 23 September 2026 at 21:04 GMT+03:00 (Europe/Istanbul)',
		)
		expect(unattendedNote('post', { now: at, tz: 'Europe/Istanbul' })).toContain(
			'- It is now Wednesday, 23 September 2026 at 21:04 GMT+03:00 (Europe/Istanbul). Use this as the current local time',
		)
	})

	it('reaches the run’s system prompt, in the job’s zone', async () => {
		const bodies: string[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>(async (_input, init) => {
				bodies.push(String(init?.body ?? ''))
				return completion()
			}),
		)
		const job = confirmedJob(sb, { when: '0 9 * * *', tz: 'Asia/Tokyo' })
		const { result } = await fire(job, { now: () => new Date('2026-09-23T18:04:00Z') })
		expect(result?.status).toBe('completed')
		expect(bodies.join('\n')).toContain(
			'It is now Thursday, 24 September 2026 at 03:04 GMT+09:00 (Asia/Tokyo)',
		)
	})
})

describe('the environment a run starts with', () => {
	it('carries what a window needs', () => {
		expect(CHILD_ENV_ALLOWLIST).toEqual(
			expect.arrayContaining(['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']),
		)
	})
})
