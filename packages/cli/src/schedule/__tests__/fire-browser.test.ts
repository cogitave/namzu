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
import { runFire } from '../fire/fire.js'
import { readRunResult } from '../fire/result.js'
import { unattendedNote } from '../fire/unattended-note.js'
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

describe('the environment a run starts with', () => {
	it('carries what a window needs', () => {
		expect(CHILD_ENV_ALLOWLIST).toEqual(
			expect.arrayContaining(['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']),
		)
	})
})
