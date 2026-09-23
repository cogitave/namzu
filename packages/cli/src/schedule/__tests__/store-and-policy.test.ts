/**
 * The scheduler's files and what a job may do.
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AuthorizationGate, NOOP_LOGGER } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JobRequestError, buildJob, confirmJob, runsPerDay } from '../build.js'
import { compileJobPolicy, expandPermissions, scheduledRunFloor } from '../policy.js'
import { ScheduleFormatError, publishExclusive, readVersioned } from '../store/atomic.js'
import { claimOccurrence, isClaimed } from '../store/claims.js'
import { computeProjectDigest, projectDigestChanges } from '../store/digest.js'
import { appendHistory, foldHistory, readHistory } from '../store/history.js'
import {
	ScheduleConflictError,
	confirmationHolds,
	createJob,
	findJob,
	readJob,
	updateJob,
} from '../store/jobs.js'
import { type Sandbox, confirmedJob, jobRequest, sandbox } from './fixtures.js'

let sb: Sandbox
beforeEach(() => {
	sb = sandbox()
})
afterEach(() => sb.cleanup())

function gate(rules: ReturnType<typeof compileJobPolicy>['rules']) {
	return new AuthorizationGate(
		{
			enabled: true,
			allowReadOnlyTools: true,
			denyDangerousPatterns: true,
			logDecisions: false,
			rules: [...rules],
		},
		NOOP_LOGGER,
	)
}

function decide(g: AuthorizationGate, toolName: string, toolInput: unknown): string {
	return g.evaluate({ toolName, toolInput, toolDef: undefined }).decision
}

describe('jobs', () => {
	it('compare-and-set: two writers from one revision, one wins', () => {
		const job = confirmedJob(sb)
		updateJob(sb.paths, job.id, job.revision, (j) => ({ ...j, prompt: 'first' }))
		expect(() =>
			updateJob(sb.paths, job.id, job.revision, (j) => ({ ...j, prompt: 'second' })),
		).toThrow(ScheduleConflictError)
		expect(readJob(sb.paths, job.id)?.prompt).toBe('first')
	})

	it('finds by name or unambiguous id prefix, and refuses a second job of the same name', () => {
		const job = confirmedJob(sb)
		expect(findJob(sb.paths, 'nightly').id).toBe(job.id)
		expect(findJob(sb.paths, job.id.slice(0, 8)).id).toBe(job.id)
		expect(() => confirmedJob(sb)).toThrow(/already exists/)
	})

	it('a hand edit breaks the confirmation; the CLI path keeps it', () => {
		const job = confirmedJob(sb)
		expect(confirmationHolds(job)).toBe(true)
		const paused = updateJob(sb.paths, job.id, job.revision, (j) => ({ ...j, state: 'paused' }))
		expect(confirmationHolds(paused)).toBe(true)
		const file = sb.paths.job(job.id)
		writeFileSync(
			file,
			JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), prompt: 'other' }),
		)
		expect(confirmationHolds(readJob(sb.paths, job.id) as never)).toBe(false)
	})

	it('refuses a file written by a newer namzu, and leaves it alone', () => {
		const path = join(sb.home, 'future.json')
		writeFileSync(path, JSON.stringify({ v: 2, kind: 'schedule-job' }))
		expect(() => readVersioned(path, 'schedule-job')).toThrow(ScheduleFormatError)
		expect(JSON.parse(readFileSync(path, 'utf8')).v).toBe(2)
	})
})

describe('claims and history', () => {
	it('publishes an occurrence claim exactly once', () => {
		const job = confirmedJob(sb)
		const claim = {
			jobId: job.id,
			key: '1790132400000',
			daemonEpoch: 'e',
			at: new Date().toISOString(),
		}
		expect(claimOccurrence(sb.paths, { ...claim, runId: 'r1' })).toBe(true)
		expect(claimOccurrence(sb.paths, { ...claim, runId: 'r2' })).toBe(false)
		expect(isClaimed(sb.paths, job.id, claim.key)).toBe(true)
		expect(() => claimOccurrence(sb.paths, { ...claim, key: '../../x', runId: 'r3' })).toThrow(
			/key/,
		)
	})

	it('publishExclusive never shows a partial file and reports a lost race', () => {
		const path = join(sb.home, 'x', 'claim.json')
		expect(publishExclusive(path, { a: 1 })).toBe(true)
		expect(publishExclusive(path, { a: 2 })).toBe(false)
		expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 })
	})

	it('folds a run’s records: the last status wins', () => {
		const at = new Date().toISOString()
		appendHistory(sb.paths, 'j', {
			v: 1,
			kind: 'run',
			at,
			runId: 'r',
			key: '1',
			trigger: 'scheduled',
			startedAt: at,
			status: 'running',
		})
		appendHistory(sb.paths, 'j', {
			v: 1,
			kind: 'skip',
			at,
			scheduledFor: at,
			reason: 'paused',
			count: 3,
		})
		appendHistory(sb.paths, 'j', {
			v: 1,
			kind: 'run',
			at,
			runId: 'r',
			key: '1',
			trigger: 'scheduled',
			startedAt: at,
			status: 'completed',
			summary: 'x'.repeat(10_000),
		})
		const folded = foldHistory(readHistory(sb.paths, 'j'))
		expect(folded).toHaveLength(2)
		expect(folded.find((r) => r.kind === 'run')).toMatchObject({ status: 'completed' })
		expect(
			readFileSync(sb.paths.historyOf('j'), 'utf8')
				.split('\n')
				.every((l) => l.length < 4_096),
		).toBe(true)
	})
})

describe('the project digest', () => {
	it('changes when a hook, a command or a plugin appears, not for unrelated settings', () => {
		const pinned = computeProjectDigest(sb.project)
		writeFileSync(
			join(sb.project, 'namzu.config.json'),
			JSON.stringify({ compaction: { strategy: 'salience' } }),
		)
		expect(projectDigestChanges(pinned, computeProjectDigest(sb.project))).toEqual([])
		writeFileSync(
			join(sb.project, 'namzu.config.json'),
			JSON.stringify({ hooks: { SessionStart: [] } }),
		)
		expect(projectDigestChanges(pinned, computeProjectDigest(sb.project))).toEqual([
			'namzu.config.json',
		])
		mkdirSync(join(sb.project, '.namzu', 'commands'), { recursive: true })
		writeFileSync(join(sb.project, '.namzu', 'commands', 'x.md'), 'do it')
		expect(projectDigestChanges(pinned, computeProjectDigest(sb.project))).toContain(
			'.namzu/commands',
		)
	})
})

describe('building a job', () => {
	const build = (over: Parameters<typeof jobRequest>[1] = {}) =>
		buildJob(jobRequest(sb, over), {
			paths: sb.paths,
			config: {},
			now: new Date(),
			osHome: sb.osHome,
		})

	it('refuses the root, the home directory, NAMZU_HOME and anything around it', () => {
		expect(() => build({ folder: '/' })).toThrow(/root/)
		expect(() => build({ folder: sb.osHome })).toThrow(/home directory/)
		expect(() => build({ folder: sb.home })).toThrow(/NAMZU_HOME/)
		mkdirSync(join(sb.home, 'inner'))
		expect(() => build({ folder: join(sb.home, 'inner') })).toThrow(/inside NAMZU_HOME/)
		const around = join(sb.root, 'around')
		mkdirSync(around)
		symlinkSync(sb.home, join(around, 'home-link'))
		expect(() => build({ folder: sb.root })).toThrow(/contains NAMZU_HOME/)
	})

	it('requires a permission set, and a flag for unmatched: allow on the host', () => {
		expect(() => build({ permissions: {} })).toThrow(/no default/)
		expect(() => build({ permissions: { rules: {}, unmatched: 'allow' } })).toThrow(
			/--allow-unattended-host/,
		)
		expect(
			build({ permissions: { rules: {}, unmatched: 'allow' }, allowUnattendedHost: true })
				.permissions.unmatched,
		).toBe('allow')
		expect(
			build({ permissions: { rules: {}, unmatched: 'allow', execution: 'sandbox' } }).permissions
				.execution,
		).toBe('sandbox')
	})

	it('always has a token budget and a wall clock above zero', () => {
		const job = build()
		expect(job.budget.tokenBudget).toBe(500_000)
		expect(job.budget.timeoutMs).toBe(1_800_000)
		expect(() => build({ budget: { tokenBudget: 0 } })).toThrow(JobRequestError)
	})

	it('is inert until confirmed on a terminal or in the TUI', () => {
		const built = build()
		expect(built.state).toBe('pending-confirmation')
		expect(confirmJob(built, 'cli-noninteractive', new Date()).confirmation).toBeNull()
		const confirmed = confirmJob(built, 'tui', new Date())
		expect(confirmed.state).toBe('active')
		expect(confirmed.trust?.canonical).toBe(built.folder.canonical)
		expect(confirmationHolds(createJob(sb.paths, confirmed))).toBe(true)
	})

	it('knows how many times a day a schedule can fire', () => {
		const now = new Date('2026-09-23T00:00:00Z')
		expect(runsPerDay({ kind: 'every', everyMs: 60_000, anchorAt: now.toISOString() }, now)).toBe(
			1_440,
		)
		expect(runsPerDay({ kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' }, now)).toBe(1)
	})
})

describe('what a scheduled run may do', () => {
	it('the presets never reach the network', () => {
		for (const preset of ['read-only', 'edit-in-folder'] as const) {
			const set = expandPermissions({ preset })
			const policy = compileJobPolicy(set, { layers: [], namzuHome: sb.home })
			expect(policy.network).toBe(false)
			expect(decide(gate(policy.rules), 'web_fetch', { url: 'https://example.com' })).toBe('deny')
		}
	})

	it('allows come only from the job; a deny in any config file holds', () => {
		const set = expandPermissions({ rules: { bash: 'ask', edit: 'allow' }, unmatched: 'park' })
		const policy = compileJobPolicy(set, {
			layers: [
				{ source: 'project-file', path: '/p/namzu.config.json', permissions: { bash: 'allow' } },
				{ source: 'user-file', path: '/u/config.yaml', permissions: { edit: 'deny' } },
			],
			namzuHome: sb.home,
		})
		const g = gate(policy.rules)
		expect(decide(g, 'bash', { command: 'ls' })).toBe('review')
		expect(decide(g, 'edit', { path: 'a', old_string: 'x', new_string: 'y' })).toBe('deny')
		expect(policy.mode).toBe('prompt')
	})

	it('denies stopping the scheduler and touching NAMZU_HOME, and not a sibling of it', () => {
		const g = gate(scheduledRunFloor(sb.home))
		expect(decide(g, 'bash', { command: 'systemctl --user stop namzu-scheduler' })).toBe('deny')
		expect(decide(g, 'bash', { command: 'launchctl bootout gui/501/com.namzu.scheduler' })).toBe(
			'deny',
		)
		expect(decide(g, 'bash', { command: 'schtasks.exe /Delete /TN \\namzu\\x /F' })).toBe('deny')
		expect(decide(g, 'bash', { command: `echo x > ${sb.home}/schedule/jobs/a.json` })).toBe('deny')
		expect(decide(g, 'write', { path: `${sb.home}/config.yaml`, content: '' })).toBe('deny')
		expect(decide(g, 'bash', { command: 'echo $NAMZU_HOME' })).toBe('deny')
		expect(decide(g, 'bash', { command: `ls ${sb.home}-other` })).not.toBe('deny')
		expect(existsSync(sb.home)).toBe(true)
	})

	it('maps unmatched to the review mode', () => {
		const mode = (unmatched: 'park' | 'deny' | 'allow') =>
			compileJobPolicy(expandPermissions({ rules: {}, unmatched }), {
				layers: [],
				namzuHome: sb.home,
			}).mode
		expect([mode('park'), mode('deny'), mode('allow')]).toEqual(['prompt', 'strict', 'auto'])
	})
})
