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

	it('still denies a scheduler command the shell reads the same with quotes or backslashes', () => {
		const g = gate(scheduledRunFloor(sb.home))
		for (const command of [
			'namzu schedule confirm probe',
			'namzu "schedule" confirm probe',
			"namzu 'schedule' 'confirm' probe",
			'namzu sch""edule con\\firm probe',
			'NAMZU Schedule Pause probe',
			'systemctl --user "stop" \'namzu-scheduler\'',
			'launchctl boot""out gui/501/com.namzu.scheduler',
		])
			expect(decide(g, 'bash', { command }), command).toBe('deny')
		expect(decide(g, 'bash', { command: 'namzu schedule list' })).not.toBe('deny')
	})

	it('denies every scheduler command that changes something, however the CLI is reached', () => {
		const g = gate(scheduledRunFloor(sb.home))
		for (const command of [
			'npx @namzu/cli schedule stop',
			'node /usr/lib/node_modules/@namzu/cli/dist/bin.js schedule confirm x',
			'node packages/cli/dist/bin.js schedule stop',
			'namzu schedule resume paused-job',
			'namzu schedule run-now other-job',
			'namzu schedule prune --delete --yes',
			'namzu schedule add --every 1m x',
			'namzu --home /x schedule start',
			'namzu schedule --home /x stop',
			'namzu schedule "stop"',
			"namzu 'schedule' re''sume x",
			'true; namzu schedule uninstall',
			'namzu schedule list && namzu schedule stop',
		])
			expect(decide(g, 'bash', { command }), command).toBe('deny')
		for (const command of [
			'namzu schedule list',
			'namzu schedule show nightly',
			'namzu schedule "status"',
			'namzu schedule history nightly --json',
			'namzu schedule logs --job nightly',
			'echo namzu; ./schedule stop',
			'npm run scheduled-report',
		])
			expect(decide(g, 'bash', { command }), command).not.toBe('deny')
	})

	it('denies NAMZU_HOME however the path to it is written', () => {
		const user = join(sb.root, 'user-home')
		const home = join(user, '.namzu')
		const g = gate(scheduledRunFloor(home, user))
		for (const command of [
			'cat ~/.namzu/schedule/daemon/endpoint.json',
			'cat $HOME/.namzu/schedule/jobs/a.json',
			'cat "${HOME}"/.namzu/config.yaml',
			'cd ~/.namzu/schedule/jobs',
			'ls ~/.namzu',
			'ls ~/".namzu"/schedule',
			`cat ${user}//.namzu/schedule/daemon/endpoint.json`,
			`cat ${user}/./.namzu/x`,
			`ls ${home} && true`,
			`cat ${user}/".namzu"/schedule/daemon/endpoint.json`,
			`cat ${user}/'.namzu'/schedule/daemon/endpoint.json`,
			`cat "${user}/.namzu/schedule/daemon/endpoint.json"`,
			`cat ${user.replace('user-home', 'user"-"home')}/.namzu/x`,
			"cat ~/.nam''zu/schedule/daemon/endpoint.json",
			'cat ~/.nam"z"u/schedule/daemon/endpoint.json',
			'cat ~/.nam\\zu/schedule/daemon/endpoint.json',
			"cat $HOME/'.na'mzu/config.yaml",
		])
			expect(decide(g, 'bash', { command }), command).toBe('deny')
		expect(decide(g, 'read', { path: `${user}//.namzu/schedule/daemon/endpoint.json` })).toBe(
			'deny',
		)
		for (const command of [
			'ls ~/.namzu-other',
			'cat ~/.namzu.bak',
			'ls ~/project/.namzu2',
			"ls ~/.nam''zu2",
		])
			expect(decide(g, 'bash', { command }), command).not.toBe('deny')
	})

	it('reads a long run of quotes and backslashes in linear time', () => {
		const user = join(sb.root, 'user-home')
		const g = gate(scheduledRunFloor(join(user, '.namzu'), user))
		for (const filler of ['\\', '/', "'", '"', '\\"'])
			for (const prefix of [`cat ${user}`, 'cat ~/.nam', 'cat ~']) {
				const command = `${prefix}${filler.repeat(20_000)}x`
				const started = performance.now()
				decide(g, 'bash', { command })
				expect(performance.now() - started, `${prefix} + ${filler}`).toBeLessThan(500)
			}
	})

	it('keeps every floor pattern within the gate’s length limit, which refuses a longer one', () => {
		const user = join(sb.root, 'user-home')
		const deep = join(user, ...Array.from({ length: 40 }, (_, i) => `level-${i}`), '.namzu')
		for (const home of [join(user, '.namzu'), deep]) {
			const rules = scheduledRunFloor(home, user)
			for (const rule of rules) {
				if (rule.type === 'argument_pattern' || rule.type === 'custom_pattern')
					expect(rule.pattern.length, rule.pattern).toBeLessThanOrEqual(500)
			}
			expect(decide(gate(rules), 'bash', { command: `cat ${home}/config.yaml` })).toBe('deny')
		}
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
