/**
 * The scheduler's files and what a job may do.
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AuthorizationGate, NOOP_LOGGER } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JobRequestError, buildJob, confirmJob, editedJob, runsPerDay } from '../build.js'
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

/**
 * A `bash` call is read as the host's bash runs it (`commandDialect: 'bash'`),
 * as the executor asks when the host has bash; `dialect` overrides that.
 */
function decide(
	g: AuthorizationGate,
	toolName: string,
	toolInput: unknown,
	dialect: 'bash' | 'sh' | undefined = toolName === 'bash' ? 'bash' : undefined,
): string {
	return g.evaluate({
		toolName,
		toolInput,
		toolDef: undefined,
		...(dialect ? { commandDialect: dialect } : {}),
	}).decision
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
		writeFileSync(path, JSON.stringify({ v: 99, kind: 'schedule-job' }))
		expect(() => readVersioned(path, 'schedule-job', 2)).toThrow(ScheduleFormatError)
		expect(JSON.parse(readFileSync(path, 'utf8')).v).toBe(99)
	})

	it('a v:2 job file is refused by a reader whose ceiling is v:1', () => {
		const path = join(sb.home, 'v2.json')
		writeFileSync(path, JSON.stringify({ v: 2, kind: 'schedule-job', runKind: 'script' }))
		expect(() => readVersioned(path, 'schedule-job', 1)).toThrow(ScheduleFormatError)
	})

	it('a v:1 job with no runKind reads as an agent job', () => {
		const job = confirmedJob(sb)
		expect(job.v).toBe(1)
		expect(job.runKind).toBeUndefined()
		expect(readJob(sb.paths, job.id)?.runKind).toBeUndefined()
	})

	// A UX review found `createJob`'s uniqueness check and `findJob` both
	// worked only from `listJobs`'s successfully PARSED jobs, so a job file
	// `readVersioned` could not fully parse (written by a newer namzu, or
	// hand-corrupted) was invisible to both: a name collision with it went
	// undetected, and looking it up by its own name or id said "No scheduled
	// job is named…" instead of the real reason it could not be read.
	describe('a job file that cannot be fully read', () => {
		function writeUnreadable(id: string, name: string): string {
			const path = join(sb.paths.jobs, `${id}.json`)
			writeFileSync(path, JSON.stringify({ v: 99, kind: 'schedule-job', id, name }))
			return path
		}

		it('createJob refuses a name a readable job does not have, but an unreadable one does', () => {
			confirmedJob(sb) // ensures paths.jobs exists
			writeUnreadable('11111111-0000-0000-0000-000000000000', 'nightly-future')
			expect(() => confirmedJob(sb, { name: 'nightly-future' })).toThrow(
				/nightly-future.*already exists.*could not be fully read/is,
			)
		})

		it('findJob by the exact name of an unreadable job reports the real reason, not "not found"', () => {
			confirmedJob(sb)
			writeUnreadable('22222222-0000-0000-0000-000000000000', 'from-the-future')
			expect(() => findJob(sb.paths, 'from-the-future')).toThrow(
				/from-the-future.*could not be fully read.*written by a newer namzu/is,
			)
		})

		it('findJob by an id prefix only an unreadable job has reports the real reason', () => {
			confirmedJob(sb)
			const id = '33333333-0000-0000-0000-000000000000'
			writeUnreadable(id, 'from-the-future-2')
			expect(() => findJob(sb.paths, id.slice(0, 8))).toThrow(/could not be fully read/)
		})

		it('a name matching a readable and an unreadable job is an error naming both ids and how to address each', () => {
			const job = confirmedJob(sb, { name: 'clashing' })
			writeUnreadable('44444444-0000-0000-0000-000000000000', 'clashing')
			expect(() => findJob(sb.paths, 'clashing')).toThrow(
				new RegExp(`matches 2 jobs.*${job.id}.*44444444-0000.*could not be fully read`, 'is'),
			)
		})

		it('list reports how many job files could not be read, not "No scheduled jobs", when none can be', async () => {
			const { listCommand } = await import('../commands/list.js')
			const { recordingContext } = await import('./fixtures.js')
			mkdirSync(sb.paths.jobs, { recursive: true })
			writeUnreadable('55555555-0000-0000-0000-000000000000', 'unreadable-1')
			writeUnreadable('66666666-0000-0000-0000-000000000000', 'unreadable-2')
			const ctx = recordingContext()
			expect(await listCommand(ctx, ['--home', sb.home])).toBe(0)
			const printed = ctx.out.printed.join('\n')
			expect(printed).toMatch(/2 job files? could not be read/)
			expect(printed).not.toMatch(/No scheduled jobs/)
		})
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

describe('building a script/script+agent job', () => {
	const build = (over: Parameters<typeof jobRequest>[1] = {}) =>
		buildJob(jobRequest(sb, over), {
			paths: sb.paths,
			config: {},
			now: new Date(),
			osHome: sb.osHome,
		})

	it('an agent job is built exactly as before: v:1, no runKind, no script', () => {
		const job = build()
		expect(job.v).toBe(1)
		expect(job.runKind).toBeUndefined()
		expect(job.script).toBeUndefined()
	})

	it('a script job requires a non-empty script, and its prompt is unused', () => {
		expect(() => build({ runKind: 'script' })).toThrow(/script is empty/)
		const job = build({
			runKind: 'script',
			script: { body: 'echo hi', shell: 'bash' },
			permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
		})
		expect(job.prompt).toBe('')
		expect(job.runKind).toBe('script')
		expect(job.script).toEqual({ body: 'echo hi', shell: 'bash', timeoutMs: 120_000 })
		expect(job.v).toBe(2)
	})

	it('a script+agent job requires both a gate script and a prompt', () => {
		expect(() =>
			build({ runKind: 'script+agent', script: { body: 'echo hi', shell: 'bash' }, prompt: '  ' }),
		).toThrow(/prompt is empty/)
		const job = build({
			runKind: 'script+agent',
			script: { body: 'echo hi', shell: 'bash' },
			permissions: { rules: { bash: 'allow' }, unmatched: 'park' },
		})
		expect(job.prompt).not.toBe('')
		expect(job.wakeGate).toEqual({ maxContextChars: 4_000 })
	})

	it('an agent job cannot carry a script, and a wake-gate needs script+agent', () => {
		expect(() => build({ script: { body: 'echo hi', shell: 'bash' } })).toThrow(/no script/)
		expect(() =>
			build({
				runKind: 'script',
				script: { body: 'echo hi', shell: 'bash' },
				wakeGate: { maxContextChars: 10 },
				permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
			}),
		).toThrow(/wake-gate only applies to a script\+agent job/)
	})

	it('refuses unmatched: park on a pure script job: nothing can wait for the operator', () => {
		expect(() =>
			build({
				runKind: 'script',
				script: { body: 'echo hi', shell: 'bash' },
				permissions: { rules: { bash: 'allow' }, unmatched: 'park' },
			}),
		).toThrow(/unmatched: park/)
	})

	it('refuses execution: sandbox for a script/script+agent job in v1', () => {
		expect(() =>
			build({
				runKind: 'script',
				script: { body: 'echo hi', shell: 'bash' },
				permissions: { rules: { bash: 'allow' }, unmatched: 'deny', execution: 'sandbox' },
			}),
		).toThrow(/execution: sandbox is not yet supported/)
	})

	it('refuses a script/script+agent job on native (non-WSL) Windows', () => {
		const real = process.platform
		Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
		try {
			expect(() =>
				build({
					runKind: 'script',
					script: { body: 'echo hi', shell: 'bash' },
					permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
				}),
			).toThrow(/not supported on native Windows/)
		} finally {
			Object.defineProperty(process, 'platform', { value: real })
		}
	})

	it('editedJob preserves runKind/script when the edit does not touch them', () => {
		const current = build({
			runKind: 'script',
			script: { body: 'echo hi', shell: 'bash' },
			permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
		})
		const rebuilt = build({
			runKind: 'script',
			script: { body: 'echo hi', shell: 'bash' },
			permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
			when: '0 4 * * *',
		})
		const edited = editedJob(current, rebuilt)
		expect(edited.runKind).toBe('script')
		expect(edited.script).toEqual(current.script)
	})
})

describe('the script digest', () => {
	it('two jobs differing only in script.body produce different security digests', () => {
		const base = (body: string) =>
			buildJob(
				jobRequest(sb, {
					runKind: 'script',
					script: { body, shell: 'bash' },
					permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
				}),
				{ paths: sb.paths, config: {}, now: new Date(), osHome: sb.osHome },
			)
		const a = confirmJob(base('echo one'), 'cli-tty', new Date())
		const b = confirmJob(base('echo two'), 'cli-tty', new Date())
		expect(a.confirmation?.digest).not.toBe(b.confirmation?.digest)
	})

	it('editing the confirmed script invalidates confirmationHolds, like editing the prompt', () => {
		const built = buildJob(
			jobRequest(sb, {
				runKind: 'script',
				script: { body: 'echo one', shell: 'bash' },
				permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
			}),
			{ paths: sb.paths, config: {}, now: new Date(), osHome: sb.osHome },
		)
		const confirmed = confirmJob(built, 'cli-tty', new Date())
		expect(confirmationHolds(confirmed)).toBe(true)
		const tampered = { ...confirmed, script: { ...confirmed.script, body: 'echo tampered' } }
		expect(confirmationHolds(tampered as never)).toBe(false)
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
			"namzu sch$'e'dule confirm probe",
			'namzu $"schedule" $\'confirm\' probe',
			"namzu schedule $'list' && namzu schedule $'stop'",
			"systemctl --user $'stop' namzu-sched$'u'ler",
			// A line continuation: the shell drops a backslash-newline anywhere.
			'namzu sche\\\ndule confirm probe',
			'nam\\\nzu schedule confirm probe',
			'namzu \\\nschedule \\\nconfirm probe',
			'namzu \\\n  --home /x \\\n  schedule stop',
			'node x/bin\\\n.js schedule stop',
			'systemctl --user \\\nstop namzu-scheduler',
			'sys\\\ntemctl --user sto\\\np namzu-sched\\\nuler',
			'launchctl \\\nbootout gui/501/com.namzu.scheduler',
			'schtasks /Delete \\\n/TN \\namzu\\x /F',
			'pkill \\\n  namzu',
			'echo done\nnamzu schedule stop',
		])
			expect(decide(g, 'bash', { command }), command).toBe('deny')
		for (const command of [
			// The regex floor searched for the verb past the end of the command
			// that named the CLI, and denied these. The lexer knows where each
			// command ends: `./schedule` is a program of its own.
			'echo namzu\n./schedule stop',
			'namzu schedule list',
			'namzu schedule \\\nlist',
			'systemctl --user status namzu-scheduler',
		])
			expect(decide(g, 'bash', { command }), command).not.toBe('deny')
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
			// A separator inside a quoted option value ends no command.
			"namzu --add-dir ';' schedule confirm x",
			"namzu --add-dir 'a|b' schedule confirm x",
			'namzu --profile "x&y" schedule run x',
			'namzu --add-dir a\\;b schedule stop',
			'node x/bin.js --add-dir ";" schedule stop',
		])
			expect(decide(g, 'bash', { command }), command).toBe('deny')
		for (const command of [
			// Denied by the regex floor, which searched past the command's end.
			'echo namzu; ./schedule stop',
			'namzu schedule list',
			'namzu schedule show nightly',
			'namzu schedule "status"',
			'namzu schedule history nightly --json',
			'namzu schedule logs --job nightly',
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
			`cat ${user}/''/.namzu/schedule/daemon/endpoint.json`,
			`cat ${user}/""/.namzu/schedule/daemon/endpoint.json`,
			`cat ${user}/'.'/.namzu/x`,
			"cat ~/''/.namzu/schedule/daemon/endpoint.json",
			'cat ~/.NAMZU/schedule/daemon/endpoint.json',
			`cat ${user.toUpperCase()}/.Namzu/x`,
			`cat \\${user}/.namzu/x`,
			`cat ${user}/$'.namzu'/schedule/daemon/endpoint.json`,
			`cat ${user}/$".namzu"/schedule/daemon/endpoint.json`,
			`cat ${user}/$''/.namzu/x`,
			"cat ~/$'.namzu'/schedule/daemon/endpoint.json",
			"cat ~/.nam$'z'u/schedule/daemon/endpoint.json",
			'cat ~/.nam$"z"u/schedule/daemon/endpoint.json',
			"cat $HOME/$'.na'mzu/config.yaml",
			// A line continuation, in a segment, around a separator, in a variable.
			'cat ~/.nam\\\nzu/schedule/daemon/endpoint.json',
			`cat ${user}/.nam\\\nzu/x`,
			`cat ${user}/\\\n.namzu/x`,
			`cat ${user}\\\n/.namzu/x`,
			`cat \\\n${user}/.namzu/x`,
			'cat ~\\\n/.namzu/x',
			'cat $HOME/\\\n.namzu/x',
			'cat $HO\\\nME/.namzu/x',
			'echo $NAMZU\\\n_HOME',
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
			"ls ~/.nam$'z'u2",
			'ls ~/.nam\\\nzu2',
			'ls ~/.nam\\nzu',
		])
			expect(decide(g, 'bash', { command }), command).not.toBe('deny')
	})

	it('reads a long run of quotes, backslashes and `/.` in linear time', () => {
		const user = join(sb.root, 'user-home')
		const g = gate(scheduledRunFloor(join(user, '.namzu'), user))
		for (const filler of [
			'\\',
			'/',
			"'",
			'"',
			'\\"',
			'/.',
			"/''",
			'/""',
			'/./',
			"/'.'",
			'/..',
			'\\"/',
			"$'",
			'$"',
			"/$''",
			"$'/",
			'\\\n',
			'\\\\\n',
			'/\\\n',
			"\\\n'",
			'\n',
		])
			for (const prefix of [`cat ${user}`, 'cat ~/.nam', 'cat ~']) {
				const command = `${prefix}${filler.repeat(20_000)}x`
				const started = performance.now()
				decide(g, 'bash', { command })
				expect(performance.now() - started, `${prefix} + ${filler}`).toBeLessThan(500)
			}
	})

	it('reads a long command that repeats a scheduler word in linear time', () => {
		const g = gate(scheduledRunFloor(sb.home))
		for (const filler of [
			'systemctl ',
			'systemctl stop ',
			'launchctl bootout ',
			'schtasks /Delete ',
			'pkill ',
			'namzu ',
			'namzu schedule ',
			'bin.js ',
			';namzu',
			'namzu \\\n',
			'\\\n',
		]) {
			const command = `${filler.repeat(Math.ceil(160_000 / filler.length))}x`
			const started = performance.now()
			decide(g, 'bash', { command })
			expect(performance.now() - started, filler).toBeLessThan(500)
		}
	})

	it('reads a long run of blank lines in linear time, in any tool', () => {
		// The NAMZU_HOME rule reads every tool's arguments as JSON text, where a
		// newline is `\\n`. Its lookbehind once walked back through the whole
		// run from each of them: 80 KB of blank lines in a note took 17 s.
		// Measured with a short home: the sandbox's own, longer one did not
		// show the slowdown.
		const g = gate(scheduledRunFloor('/home/u/.namzu', '/home/u'))
		const blank = `a${'\n'.repeat(80_000)}`
		for (const [tool, input] of [
			['write', { path: 'notes.md', content: blank }],
			['bash', { command: blank }],
		] as const) {
			const started = performance.now()
			decide(g, tool, input)
			expect(performance.now() - started, tool).toBeLessThan(500)
		}
	})

	it('reads a NAMZU_HOME of any length or depth', () => {
		const user = join(sb.root, 'user-home')
		const deep = join(user, ...Array.from({ length: 40 }, (_, i) => `level-${i}`), '.namzu')
		for (const home of [
			join(user, '.namzu'),
			deep,
			'/srv/namzu-scheduler-state-directory',
			`/srv/${'a'.repeat(30)}`,
			`/srv/${'a'.repeat(255)}`,
			`/${'.'.repeat(255)}`,
		]) {
			const g = gate(scheduledRunFloor(home, user))
			expect(decide(g, 'bash', { command: `cat ${home}/config.yaml` })).toBe('deny')
			expect(decide(g, 'read', { path: `${home}/config.yaml` })).toBe('deny')
		}
		// The regex floor, capped at 500 characters a pattern, matched a name
		// too long to spell whole by its start, in any segment, and so denied
		// this. The path is compared whole now.
		const long = gate(scheduledRunFloor(`/srv/${'a'.repeat(255)}`, user))
		expect(decide(long, 'bash', { command: `cat /tmp/${'a'.repeat(100)}/x` })).not.toBe('deny')
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
