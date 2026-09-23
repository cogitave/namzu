/**
 * A scheduled job with a browser grant, where a person meets it: the model's
 * proposal and its confirmation, and a run parked because a page needs the
 * operator — what `schedule list`, `show`, `status`, `/schedule` and the
 * startup line say about it, and what continuing it in the TUI needs.
 */

import { BrowserProfileStore } from '@namzu/browser'
import {
	NOOP_LOGGER,
	buildScheduleTools,
	defineTool,
	hostTimeZone,
	mcpJsonSchemaToZod,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetCliLoggerForTests } from '../../logging.js'
import {
	DEEPSEEK,
	type Sandbox,
	completion,
	confirmedJob,
	recordingContext,
	sandbox,
} from '../../schedule/__tests__/fixtures.js'
import { editCommand } from '../../schedule/commands/add.js'
import { listCommand, showCommand } from '../../schedule/commands/list.js'
import { statusCommand } from '../../schedule/commands/service.js'
import { ScheduleDaemon } from '../../schedule/daemon/daemon.js'
import { runFire } from '../../schedule/fire/fire.js'
import { listJobs } from '../../schedule/store/jobs.js'
import { readState } from '../../schedule/store/state.js'
import { createAgentSession } from '../agent.js'
import { listScheduleJobs, runScheduleCommand } from './host-commands.js'
import { prepareScheduledResume, scheduledResumeMismatch } from './resume.js'
import { scheduleStartupLine } from './startup.js'
import { createScheduleToolHost } from './tool-host.js'

let sb: Sandbox
let responses: (() => Response)[]
beforeEach(() => {
	sb = sandbox()
	responses = []
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async () => (responses.shift() ?? completion)()),
	)
})
afterEach(() => {
	vi.unstubAllGlobals()
	__resetCliLoggerForTests()
	sb.cleanup()
})

const REASON = 'Sign in to http://localhost:8123 in the browser (profile social), then continue.'

const agent = {
	probeAgentSession: async () => ({
		preferences: null,
		needsRepickReason: null,
		detected: [DEEPSEEK],
		credentialGap: null,
	}),
	createAgentSession: ((prefs, detected, options) =>
		createAgentSession(prefs, detected, {
			...options,
			extraTools: [
				defineTool({
					name: 'sign_in_probe',
					description: 'Opens a page that turns out to need a sign-in',
					inputSchema: mcpJsonSchemaToZod({ type: 'object', properties: {} }),
					category: 'custom',
					permissions: [],
					readOnly: true,
					destructive: false,
					concurrencySafe: true,
					async execute() {
						return {
							success: false,
							output: 'The page is a sign-in form.',
							error: 'sign-in required',
							handoff: { kind: 'human-required' as const, reason: REASON },
						}
					},
				}),
			],
		})) as typeof createAgentSession,
}

const GRANT = { profile: 'social', sites: { 'http://localhost:8123': 'act' } }

/** A browser job's run, parked because a page needs the operator. */
async function parkedOnSignIn() {
	new BrowserProfileStore(sb.home).ensureLocal('social', 'chromium')
	const job = confirmedJob(sb, {
		permissions: { rules: {}, unmatched: 'allow', browser: GRANT },
		allowUnattendedHost: true,
	})
	responses.push(() => completion({ name: 'sign_in_probe', input: {} }))
	const d = new ScheduleDaemon({
		paths: sb.paths,
		log: NOOP_LOGGER,
		version: 't',
		epoch: 'e',
		maxConcurrentRuns: 1,
		notifications: false,
		spawnFire: (req) => ({
			exited: runFire(
				recordingContext(),
				sb.paths,
				{
					jobId: req.job.id,
					runId: req.runId,
					key: req.key,
					revision: req.job.revision,
					trigger: req.trigger,
				},
				{
					agent,
					keepLogging: true,
					browserPreflight: async () => ({ ok: true, engine: 'local', warnings: [] }),
				},
			),
			terminate: () => {},
		}),
		notify: async () => {},
		fingerprint: () => 'x',
		watchJobs: false,
	})
	await d.claimOwnership()
	d.requestRunNow(job.id)
	await d.tick()
	for (
		let i = 0;
		i < 300 && readState(sb.paths, job.id).activeRun?.status !== 'awaiting-approval';
		i++
	) {
		await new Promise((r) => setTimeout(r, 10))
	}
	const run = readState(sb.paths, job.id).activeRun
	expect(run?.status).toBe('awaiting-approval')
	return { job, run: run as NonNullable<typeof run> }
}

describe('a browser job parked because a page needs the operator', () => {
	it('says "needs you: <reason>" everywhere, not "waiting for approval"', async () => {
		const { run } = await parkedOnSignIn()
		expect(run.handoff).toEqual({ reason: REASON })

		const list = recordingContext()
		await listCommand(list, ['--home', sb.home])
		expect(String(list.out.printed[0])).toContain(`needs you: ${REASON}`)
		expect(String(list.out.printed[0])).not.toContain('WAITING FOR APPROVAL')
		expect(String(list.out.printed[0])).toContain('when that is done, continue it: cd ')

		const listJson = recordingContext()
		await listCommand(listJson, ['--home', sb.home, '--json'])
		expect(JSON.parse(String(listJson.out.printed[0])).jobs[0].activeRun.handoff).toEqual({
			reason: REASON,
		})

		const show = recordingContext()
		await showCommand(show, ['nightly', '--home', sb.home])
		expect(String(show.out.printed[0])).toMatch(
			new RegExp(`Waiting {5}needs you: ${REASON.replace(/[.()]/g, '\\$&')}; when that is done`),
		)

		const status = recordingContext()
		await statusCommand(status, ['--home', sb.home])
		expect(String(status.out.printed[0])).toContain(`Waiting        nightly needs you: ${REASON}`)

		const tui = await listScheduleJobs({ home: sb.home, cwd: sb.project } as never)
		expect(tui).toContain(`⚠ needs you: ${REASON}`)
		expect(tui).not.toContain('WAITING FOR YOUR APPROVAL')

		expect(scheduleStartupLine(sb.home, sb.project, Date.now() + 1)).toContain(
			`nightly needs you: ${REASON}`,
		)
	})

	it('continues in the TUI on the job’s profile, held to the job’s sites', async () => {
		const { run } = await parkedOnSignIn()
		const scheduled = await prepareScheduledResume({
			home: sb.home,
			sessionId: run.sessionId as string,
			operatorMode: 'auto',
			environment: { cwd: sb.project, roots: [], sandboxed: false, browser: true },
			ask: async () => ({ kind: 'approve' }),
			choose: async () => ({ kind: 'answer', selectedOptionIds: ['continue'] }),
			say: () => {},
		})
		expect(scheduled && 'browser' in scheduled ? scheduled.browser : undefined).toEqual({
			profile: 'social',
			sites: { 'http://localhost:8123': 'act', '*': 'deny' },
		})
	})

	it('continues on the host a job whose runs cannot run a command, though it names the sandbox', () => {
		const job = confirmedJob(sb, {
			permissions: { preset: 'read-only', unmatched: 'deny', execution: 'sandbox', browser: GRANT },
		})
		expect(
			scheduledResumeMismatch(job, { cwd: sb.project, roots: [], sandboxed: false, browser: true }),
		).toEqual([])
		const shell = confirmedJob(sb, {
			name: 'with-shell',
			permissions: { preset: 'edit-in-folder', execution: 'sandbox' },
		})
		expect(
			scheduledResumeMismatch(shell, { cwd: sb.project, roots: [], sandboxed: false }),
		).toEqual([expect.stringMatching(/in a sandbox and this session runs them on the host/)])
	})

	it('cannot continue in a session without the browser', async () => {
		const job = confirmedJob(sb, {
			permissions: { preset: 'read-only', unmatched: 'park', browser: GRANT },
		})
		expect(
			scheduledResumeMismatch(job, {
				cwd: sb.project,
				roots: [],
				sandboxed: false,
				browser: false,
			}),
		).toEqual([expect.stringMatching(/drives the browser and this session has none/)])
	})
})

describe('the model proposing a browser job', () => {
	function host(answer: string) {
		const said: string[] = []
		const h = createScheduleToolHost({
			home: () => sb.home,
			cwd: () => sb.project,
			extraRoots: () => [],
			model: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
			config: () => ({}),
			sessionId: () => undefined,
			say: (t) => said.push(t),
			ask: async () => ({ kind: 'answer', selectedOptionIds: [answer] }),
		})
		const [tool] = buildScheduleTools(h)
		return { tool: tool as NonNullable<typeof tool>, said }
	}
	const input = {
		action: 'create',
		name: 'good-morning',
		prompt: 'Post "Günaydın!" with the time on my social account.',
		when: 'every 5m',
		permissions: {
			preset: 'read-only',
			unmatched: 'park',
			browser: { profile: 'social', sites: { 'HTTP://LOCALHOST:8123/': 'act' } },
		},
	}

	it('is offered to the operator with the grant spelled out, and created only on Create', async () => {
		const cancelled = host('cancel')
		expect((await cancelled.tool.execute(input, {} as never)).success).toBe(false)
		const shown = cancelled.said[0] ?? ''
		expect(shown).toContain(
			'Browser     SIGNED IN AS YOU: profile social, only http://localhost:8123',
		)
		expect(shown).toContain('browser http://localhost:8123: open, read and change without asking')
		expect(shown).toContain('browser any other site: deny')
		expect(shown).toContain('browser sign-in, CAPTCHA or a code: the run stops and tells you')
		expect(listJobs(sb.paths).jobs).toHaveLength(0)

		const created = host('create')
		expect((await created.tool.execute(input, {} as never)).success).toBe(true)
		const [job] = listJobs(sb.paths).jobs
		expect(job?.permissions.browser).toEqual({
			profile: 'social',
			sites: { 'http://localhost:8123': 'act' },
		})
		expect(job?.confirmation?.surface).toBe('tool-confirmed')
	})

	it('warns on the confirmation when a run may take too few steps', async () => {
		const few = host('cancel')
		await few.tool.execute({ ...input, budget: { maxIterations: 1 } }, {} as never)
		expect(few.said[0]).toContain(
			'Warning     1 iteration is one model call with its tool calls; most tasks need more (the default is 50), and a run that runs out stops unfinished',
		)
		const enough = host('cancel')
		await enough.tool.execute(input, {} as never)
		expect(enough.said[0]).not.toContain('iteration is one model call')
		expect(enough.said[0]).not.toContain('may not cover even a few model calls')
		const cheap = host('cancel')
		await cheap.tool.execute({ ...input, budget: { tokenBudget: 4000 } }, {} as never)
		expect(cheap.said[0]).toContain(
			'Warning     4,000 tokens may not cover even a few model calls, each of which resends the whole prompt; a run that runs out stops unfinished (the default is 500,000)',
		)
	})

	it('says a job does nothing until the scheduler is installed, to the person and the model', async () => {
		const created = host('create')
		const result = await created.tool.execute(input, {} as never)
		expect(created.said.join('\n')).toContain(
			'The scheduler is not installed, so it does not run until you install it: namzu schedule install.',
		)
		expect(result.output).toContain(
			'No scheduler is installed on this machine, so the job does not run until the operator runs `namzu schedule install`.',
		)
	})

	it('marks every optional value the model chose instead of the default', async () => {
		const chose = host('cancel')
		await chose.tool.execute(
			{
				...input,
				tz: 'America/New_York',
				permissions: { ...input.permissions, execution: 'sandbox' },
				budget: { tokenBudget: 12000 },
			},
			{} as never,
		)
		const shown = chose.said[0] ?? ''
		expect(shown).toContain(
			`Warning     Chosen by the model, not the default: time zone America/New_York, not this machine's ${hostTimeZone()}`,
		)
		expect(shown).toContain(
			'Chosen by the model, not the default: commands run in the sandbox; the default is this machine',
		)
		expect(shown).toContain(
			'Chosen by the model, not the default: 12,000 tokens per run (the default is 500,000)',
		)
		const plain = host('cancel')
		await plain.tool.execute(input, {} as never)
		expect(plain.said[0]).not.toContain('Chosen by the model')
	})

	it('cannot grant every site', async () => {
		const { tool } = host('create')
		const refused = await tool.execute(
			{
				...input,
				permissions: {
					...input.permissions,
					browser: { profile: 'social', sites: { '*': 'act' } },
				},
			},
			{} as never,
		)
		expect(refused.success).toBe(false)
		expect(refused.error).toMatch(/every site/)
		expect(listJobs(sb.paths).jobs).toHaveLength(0)
	})
})

describe('/schedule confirm after an edit saved without a terminal', () => {
	it('shows what changed since the job was last confirmed', async () => {
		confirmedJob(sb, {
			name: 'post',
			permissions: { preset: 'read-only', unmatched: 'park', browser: GRANT },
		})
		await editCommand(recordingContext(), [
			'post',
			'--home',
			sb.home,
			'--browser-site',
			'https://news.example=read',
			'--yes',
		])
		const said: string[] = []
		await runScheduleCommand(['confirm', 'post'], {
			home: sb.home,
			cwd: sb.project,
			config: {},
			say: (text) => said.push(text),
			ask: async () => ({ kind: 'answer', selectedOptionIds: ['cancel'] }),
		})
		expect(said.join('\n')).toContain('Changed since it was last confirmed')
		expect(said.join('\n')).toContain(
			'  + browser https://news.example: open and read, never change',
		)
	})
})
