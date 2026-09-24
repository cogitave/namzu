/**
 * The TUI's scheduler surfaces: answering a parked scheduled run under the
 * job's rules, the model-tool host that computes what it shows, `/loop`'s
 * timing, and the startup line.
 */

import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { NOOP_LOGGER, buildScheduleTools, defineTool, mcpJsonSchemaToZod } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openSessions, startConversation } from '../../integrations/sessions/store.js'
import { __resetCliLoggerForTests } from '../../logging.js'
import {
	DEEPSEEK,
	type Sandbox,
	completion,
	confirmedJob,
	recordingContext,
	sandbox,
} from '../../schedule/__tests__/fixtures.js'
import { settleAnsweredPark } from '../../schedule/commands/lifecycle.js'
import { ScheduleDaemon } from '../../schedule/daemon/daemon.js'
import { runFire } from '../../schedule/fire/fire.js'
import { appendHistory, foldHistory, readHistory } from '../../schedule/store/history.js'
import { confirmationHolds, listJobs, readJob, updateJob } from '../../schedule/store/jobs.js'
import { readState } from '../../schedule/store/state.js'
import {
	type PermissionRequest,
	type ScreenPermissionRequest,
	type UserQuestion,
	createAgentSession,
} from '../agent.js'
import { SessionLoopScheduler } from './loop-host.js'
import {
	type ScheduledResumeParams,
	prepareScheduledResume,
	scheduledResumeMismatch,
} from './resume.js'
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

const agent = {
	probeAgentSession: async () => ({
		preferences: null,
		needsRepickReason: null,
		detected: [DEEPSEEK],
		credentialGap: null,
	}),
	createAgentSession,
}

const HANDOFF_REASON = 'Sign in to example.test in the browser, then continue.'
let probeRuns = 0

/** The real session, with one tool that asks for a person. */
const handoffAgent = {
	...agent,
	createAgentSession: ((prefs, detected, options) =>
		createAgentSession(prefs, detected, {
			...options,
			extraTools: [handoffProbe()],
		})) as typeof createAgentSession,
}

function handoffProbe() {
	return defineTool({
		name: 'sign_in_probe',
		description: 'Opens a page that turns out to need a sign-in',
		inputSchema: mcpJsonSchemaToZod({ type: 'object', properties: {} }),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute() {
			probeRuns++
			return {
				success: false,
				output: 'The page is a sign-in form.',
				error: 'sign-in required',
				handoff: {
					kind: 'human-required' as const,
					reason: HANDOFF_REASON,
					detail: { origin: 'https://example.test' },
				},
			}
		},
	})
}

/** Run the job once until it parks, as the daemon would, and record the park in its state. */
async function parkedRun(marker: string) {
	const job = confirmedJob(sb, { permissions: { preset: 'edit-in-folder' } })
	responses.push(() => completion({ name: 'bash', input: { command: `touch ${marker}` } }))
	return await runUntilParked(job, agent)
}

/** Run a job whose one tool call asks for a person, until it parks. */
async function handoffParkedRun() {
	probeRuns = 0
	const job = confirmedJob(sb, {
		permissions: { rules: {}, unmatched: 'allow' },
		allowUnattendedHost: true,
	})
	responses.push(() => completion({ name: 'sign_in_probe', input: {} }))
	return await runUntilParked(job, handoffAgent)
}

async function runUntilParked(job: ReturnType<typeof confirmedJob>, runAgent: typeof agent) {
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
				{ agent: runAgent, keepLogging: true },
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
	return { job, run: run as NonNullable<typeof run>, daemon: d }
}

describe('answering a parked scheduled run', () => {
	it('runs exactly the parked batch, asks about every later call under the job’s rules, and the daemon records it completed', async () => {
		const marker = join(sb.project, 'marker')
		const second = join(sb.project, 'second')
		const third = join(sb.project, 'third')
		const { job, run, daemon } = await parkedRun(marker)
		expect(existsSync(marker)).toBe(false)

		const asked: ScreenPermissionRequest[] = []
		const ask = async (request: ScreenPermissionRequest) => {
			asked.push(request)
			// The parked batch: yes. The next: "allow all" — which the screen
			// does not offer a scheduled turn, and which, arriving anyway, is
			// taken as yes for that batch only. The one after: no.
			return asked.length === 1
				? ({ kind: 'approve' } as const)
				: asked.length === 2
					? ({ kind: 'approve-all' } as const)
					: ({ kind: 'reject', feedback: 'not now' } as const)
		}
		const scheduled = (await prepareScheduledResume({
			home: sb.home,
			sessionId: run.sessionId as string,
			operatorMode: 'auto',
			environment: { cwd: sb.project, roots: [], sandboxed: false },
			ask,
			say: () => {},
		})) as ScheduledResumeParams | undefined
		expect(scheduled?.pendingDecision).toEqual({ action: 'approve_tools' })
		// Told the time now: the park may have waited days for this answer.
		expect(scheduled?.systemNote).toMatch(/^It is now \w+day, .*This is the current local time/)
		expect(scheduled?.model).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
		expect(scheduled?.permissionMode).toBe('prompt')
		expect(asked[0]?.toolCalls[0]?.name).toBe('bash')

		// After the parked batch's result, the model asks for two more commands.
		const requestedModels: unknown[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>(async (_input, init) => {
				const body = String(init?.body ?? '')
				requestedModels.push((JSON.parse(body) as { model?: unknown }).model)
				if (!body.includes('call_2'))
					return completion({ name: 'bash', input: { command: `touch ${second}` }, id: 'call_2' })
				if (!body.includes('call_3'))
					return completion({ name: 'bash', input: { command: `touch ${third}` }, id: 'call_3' })
				return completion()
			}),
		)
		// The TUI's session for this folder: its own rules would allow bash
		// outright, and it is on another model than the job's.
		const sessions = await openSessions(sb.project, { stateRoot: sb.home })
		const session = await createAgentSession(
			{
				version: 3,
				providers: [{ id: 'deepseek', model: 'deepseek-reasoner' }],
				subagents: { active: [] },
			},
			[DEEPSEEK],
			{
				cwd: sb.project,
				stateRoot: sb.home,
				conversationSessions: sessions,
				rules: [{ type: 'allow_by_name', toolNames: ['bash'] }],
				scope: {
					sessionId: run.sessionId as never,
					topicId: sessions.topicId,
					projectId: sessions.projectId,
					tenantId: sessions.tenantId,
				},
			},
		)
		try {
			for await (const event of session.resumePaused({
				turnId: run.turnId as string,
				...scheduled,
			})) {
				if (event.kind === 'error') throw new Error(event.message)
			}
		} finally {
			await session.close()
		}
		expect(existsSync(marker)).toBe(true)
		expect(existsSync(second)).toBe(true)
		expect(existsSync(third)).toBe(false)
		expect(asked).toHaveLength(3)
		// Every request of the resumed turn went to the job's model, not the session's.
		expect(requestedModels.length).toBeGreaterThan(0)
		expect(new Set(requestedModels)).toEqual(new Set(['deepseek-chat']))
		// Every prompt was put to the screen as batch-only: no "allow all" on it.
		expect(asked.every((request) => request.batchOnly === true)).toBe(true)

		await daemon.tick()
		const record = foldHistory(readHistory(sb.paths, job.id)).find(
			(r) => r.kind === 'run' && r.runId === run.runId,
		)
		expect(record).toMatchObject({ status: 'completed' })
	})

	it('offers Continue or Abandon for a run a tool paused for a person, and Continue calls the model with the results', async () => {
		const { job, run } = await handoffParkedRun()
		expect(probeRuns).toBe(1)
		const said: string[] = []
		const questions: UserQuestion[] = []
		const asked: ScreenPermissionRequest[] = []
		const scheduled = await prepareScheduledResume({
			home: sb.home,
			sessionId: run.sessionId as string,
			operatorMode: 'auto',
			environment: { cwd: sb.project, roots: [], sandboxed: false },
			ask: async (request) => {
				asked.push(request)
				return { kind: 'approve' }
			},
			choose: async (question) => {
				questions.push(question)
				return { kind: 'answer', selectedOptionIds: ['continue'] }
			},
			say: (text) => said.push(text),
		})
		// No batch to approve: the choice is all that is asked.
		expect(asked).toHaveLength(0)
		expect(questions).toHaveLength(1)
		expect(questions[0]?.options.map((option) => option.label)).toEqual(['Continue', 'Abandon'])
		expect(said.join('\n')).toContain(HANDOFF_REASON)
		expect(said.join('\n')).toContain('site https://example.test')
		expect(said.join('\n')).not.toContain('origin: ')
		// The resumed turn is told the person dealt with it, so it tries again.
		const note = scheduled && 'systemNote' in scheduled ? scheduled.systemNote : undefined
		expect(note).toContain(`a tool needed a person: ${HANDOFF_REASON}`)
		expect(note).toContain('Try the step that stopped again')
		expect(note).toMatch(/It is now \w+day, /)
		expect(scheduled && 'pendingDecision' in scheduled).toBe(false)
		expect(scheduled && 'model' in scheduled ? scheduled.model : undefined).toEqual({
			provider: 'deepseek',
			model: 'deepseek-chat',
		})

		const bodies: string[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>(async (_input, init) => {
				bodies.push(String(init?.body ?? ''))
				return completion()
			}),
		)
		const sessions = await openSessions(sb.project, { stateRoot: sb.home })
		const session = await createAgentSession(
			{ version: 3, providers: [{ id: 'deepseek' }], subagents: { active: [] } },
			[DEEPSEEK],
			{
				cwd: sb.project,
				stateRoot: sb.home,
				conversationSessions: sessions,
				extraTools: [handoffProbe()],
				scope: {
					sessionId: run.sessionId as never,
					topicId: sessions.topicId,
					projectId: sessions.projectId,
					tenantId: sessions.tenantId,
				},
			},
		)
		try {
			for await (const event of session.resumePaused({
				turnId: run.turnId as string,
				...(scheduled as ScheduledResumeParams),
			})) {
				if (event.kind === 'error') throw new Error(event.message)
			}
		} finally {
			await session.close()
		}
		// The next step was a model call that saw the tool's result; the tool
		// did not run again.
		// The turn's own requests; a history lookup the session makes on the
		// side is not one.
		const turnRequests = bodies.filter((body) => body.includes('You are Namzu'))
		expect(turnRequests).toHaveLength(1)
		expect(turnRequests[0]).toContain('The page is a sign-in form.')
		expect(probeRuns).toBe(1)
		const settled = await settleAnsweredPark(sb.paths, job.id)
		expect(settled?.lastRun).toMatchObject({ runId: run.runId, status: 'completed' })
	})

	it('abandons a handoff park when the operator chooses Abandon, and leaves it waiting on Esc', async () => {
		const { job, run } = await handoffParkedRun()
		const prepare = (answer: 'continue' | 'abandon' | 'skip') =>
			prepareScheduledResume({
				home: sb.home,
				sessionId: run.sessionId as string,
				operatorMode: 'auto',
				environment: { cwd: sb.project, roots: [], sandboxed: false },
				ask: async () => ({ kind: 'approve' }),
				choose: async () =>
					answer === 'skip' ? { kind: 'skip' } : { kind: 'answer', selectedOptionIds: [answer] },
				say: () => {},
			})
		expect(await prepare('skip')).toEqual({ leave: true })
		expect(readState(sb.paths, job.id).activeRun?.status).toBe('awaiting-approval')
		const choice = await prepare('abandon')
		expect(choice && 'abandon' in choice).toBe(true)
	})

	it('is not a scheduled park for any other session', async () => {
		const sessions = await openSessions(sb.project, { stateRoot: sb.home })
		const id = await startConversation(sessions)
		expect(
			await prepareScheduledResume({
				home: sb.home,
				sessionId: id,
				operatorMode: 'auto',
				environment: { cwd: sb.project, roots: [], sandboxed: false },
				ask: async () => ({ kind: 'approve' }),
				say: () => {},
			}),
		).toBeUndefined()
	})

	it('refuses a session whose sandbox or roots differ from the job’s, before asking anything', async () => {
		const marker = join(sb.project, 'marker')
		const { run } = await parkedRun(marker)
		const asked: PermissionRequest[] = []
		const attempt = (environment: {
			cwd: string
			roots: string[]
			sandboxed: boolean
			providers?: string[]
		}) =>
			prepareScheduledResume({
				home: sb.home,
				sessionId: run.sessionId as string,
				operatorMode: 'auto',
				environment,
				ask: async (request) => {
					asked.push(request)
					return { kind: 'approve' }
				},
				say: () => {},
			})
		await expect(attempt({ cwd: sb.project, roots: [], sandboxed: true })).rejects.toThrow(
			/runs commands on the host and this session runs them in a sandbox.*namzu resume/,
		)
		await expect(attempt({ cwd: sb.project, roots: [sb.root], sandboxed: false })).rejects.toThrow(
			/also reaches/,
		)
		await expect(
			attempt({ cwd: sb.project, roots: [], sandboxed: false, providers: ['anthropic'] }),
		).rejects.toThrow(
			/runs on deepseek\/deepseek-chat and this session has no credential for deepseek/,
		)
		expect(asked).toHaveLength(0)
	})

	it('records the run’s end in its job once the answered turn is over, with no scheduler, once', async () => {
		const marker = join(sb.project, 'marker')
		const { job, run } = await parkedRun(marker)
		// Still parked: nothing to settle, the run stays waiting.
		await settleAnsweredPark(sb.paths, job.id)
		expect(readState(sb.paths, job.id).activeRun?.status).toBe('awaiting-approval')

		const scheduled = await prepareScheduledResume({
			home: sb.home,
			sessionId: run.sessionId as string,
			operatorMode: 'auto',
			environment: { cwd: sb.project, roots: [], sandboxed: false },
			ask: async () => ({ kind: 'approve' }),
			say: () => {},
		})
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>(async () => completion()),
		)
		const sessions = await openSessions(sb.project, { stateRoot: sb.home })
		const session = await createAgentSession(
			{ version: 3, providers: [{ id: 'deepseek' }], subagents: { active: [] } },
			[DEEPSEEK],
			{
				cwd: sb.project,
				stateRoot: sb.home,
				conversationSessions: sessions,
				scope: {
					sessionId: run.sessionId as never,
					topicId: sessions.topicId,
					projectId: sessions.projectId,
					tenantId: sessions.tenantId,
				},
			},
		)
		try {
			for await (const event of session.resumePaused({
				turnId: run.turnId as string,
				...scheduled,
			})) {
				if (event.kind === 'error') throw new Error(event.message)
			}
		} finally {
			await session.close()
		}
		// No scheduler ticks here: the answer path settles it.
		const settled = await settleAnsweredPark(sb.paths, job.id)
		expect(settled?.activeRun).toBeUndefined()
		expect(settled?.lastRun).toMatchObject({ runId: run.runId, status: 'completed' })
		// Settling again (a scheduler doing it too) writes nothing more.
		await settleAnsweredPark(sb.paths, job.id)
		const runs = readHistory(sb.paths, job.id).filter(
			(r) => r.kind === 'run' && r.runId === run.runId && r.status === 'completed',
		)
		expect(runs).toHaveLength(1)
		expect(foldHistory(readHistory(sb.paths, job.id)).find((r) => r.kind === 'run')).toMatchObject({
			status: 'completed',
		})
	})

	it('names every way a session differs from the job', () => {
		const other = mkdtempSync(join(sb.osHome, 'extra-'))
		const job = confirmedJob(sb, {
			// A job that can run commands: where they run is one of the differences.
			permissions: {
				preset: 'edit-in-folder',
				execution: 'sandbox',
				additionalDirectories: [other],
			},
		})
		expect(
			scheduledResumeMismatch(job, { cwd: sb.project, roots: [other], sandboxed: true }),
		).toEqual([])
		const reasons = scheduledResumeMismatch(job, { cwd: sb.osHome, roots: [], sandboxed: false })
		expect(reasons).toEqual([
			expect.stringMatching(/in a sandbox and this session runs them on the host/),
			expect.stringMatching(/folder is not the job/),
			expect.stringMatching(/does not reach/),
		])
	})
})

describe('the schedule tool’s host', () => {
	function host(answer: string, cwd = () => sb.project) {
		const said: string[] = []
		const questions: { options: { id: string }[] }[] = []
		const h = createScheduleToolHost({
			home: () => sb.home,
			cwd,
			extraRoots: () => [],
			model: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
			config: () => ({}),
			sessionId: () => undefined,
			say: (t) => said.push(t),
			ask: async (q) => {
				questions.push(q as never)
				return answer === 'skip'
					? { kind: 'skip' }
					: { kind: 'answer', selectedOptionIds: [answer] }
			},
		})
		const [tool] = buildScheduleTools(h)
		return { tool: tool as NonNullable<typeof tool>, said, questions }
	}
	const input = {
		action: 'create',
		name: 'proposed',
		prompt: 'List the TODO comments.',
		when: '0 9 * * 1-5',
		tz: 'UTC',
		permissions: { preset: 'read-only', unmatched: 'deny' },
	}

	it('shows its own computation with Cancel first, and creates a job only on Create', async () => {
		const { tool, said, questions } = host('cancel')
		expect((await tool.execute(input, {} as never)).success).toBe(false)
		expect(listJobs(sb.paths).jobs).toHaveLength(0)
		expect(questions[0]?.options[0]?.id).toBe('cancel')
		expect(said[0]).toContain('PROPOSED BY THE MODEL, NOT BY YOU')
		expect(said[0]).toContain(sb.project)
		expect(said[0]).toMatch(/at 09:00 on Monday through Friday \(UTC\)/)
		const yes = host('create')
		expect((await yes.tool.execute(input, {} as never)).success).toBe(true)
		const [job] = listJobs(sb.paths).jobs
		expect(job?.confirmation?.surface).toBe('tool-confirmed')
		expect(job?.state).toBe('active')
		expect(job?.model).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
	})

	it('a skipped question is a cancel', async () => {
		const { tool } = host('skip')
		expect((await tool.execute(input, {} as never)).success).toBe(false)
		expect(listJobs(sb.paths).jobs).toHaveLength(0)
	})

	it('lists every job, whatever folder it runs in, and marks the session folder’s', async () => {
		// The operator's trial: the TUI ran in the home directory, the model
		// created a job in a folder below it, and `list` (no `allFolders`)
		// said "No scheduled jobs." while `namzu schedule list` showed it.
		const below = join(sb.project, 'scheduled-test')
		mkdirSync(below)
		const { tool } = host('create')
		expect((await tool.execute({ ...input, folder: below }, {} as never)).success).toBe(true)
		confirmedJob(sb, { name: 'here', folder: sb.project })
		const listed = await tool.execute({ action: 'list' }, {} as never)
		expect(listed.output).not.toMatch(/No scheduled jobs/)
		const jobs = (
			listed.data as { jobs: { name: string; prompt?: string; inSessionFolder?: boolean }[] }
		).jobs
		expect(jobs.map((j) => j.name).sort()).toEqual(['here', 'proposed'])
		expect(jobs.find((j) => j.name === 'here')).toMatchObject({ inSessionFolder: true })
		expect(jobs.find((j) => j.name === 'here')?.prompt).toBeDefined()
		const proposed = jobs.find((j) => j.name === 'proposed')
		expect(proposed?.prompt).toBeUndefined()
		expect(proposed?.inSessionFolder).toBeUndefined()
		expect(listed.output).toMatch(/^here · .*\(this folder\)$/m)
		expect(listed.output).toMatch(/^proposed · .*scheduled-test$/m)
		// Reached through a symbolic link, the session folder is still the job's.
		const link = join(sb.root, 'link')
		symlinkSync(sb.project, link)
		const viaLink = await host('create', () => link).tool.execute({ action: 'list' }, {} as never)
		expect(viaLink.output).toMatch(/^here · .*\(this folder\)$/m)
	})

	describe('update', () => {
		// The operator's trial: asked to change a job, the model deleted it
		// and created it again, and its history went with it.
		const every2 = { ...input, name: 'alert', when: 'every 2m', prompt: 'Show the alert.' }

		it('changes the job in place after the operator saves: same id, history kept, confirmed again', async () => {
			expect((await host('create').tool.execute(every2, {} as never)).success).toBe(true)
			const [before] = listJobs(sb.paths).jobs
			const { tool, said, questions } = host('save')
			const result = await tool.execute(
				{ action: 'update', job: 'alert', when: 'every 5m', prompt: 'Show the alert twice.' },
				{} as never,
			)
			expect(result.success).toBe(true)
			expect(result.output).toMatch(/updated in place and keeps its history/)
			const [after] = listJobs(sb.paths).jobs
			expect(after?.id).toBe(before?.id)
			expect(after?.createdAt).toBe(before?.createdAt)
			expect(after?.revision).toBe((before?.revision ?? 0) + 1)
			expect(after?.prompt).toBe('Show the alert twice.')
			expect(after?.schedule).toMatchObject({ kind: 'every', everyMs: 5 * 60_000 })
			expect(after?.confirmation?.surface).toBe('tool-confirmed')
			expect(after && confirmationHolds(after)).toBe(true)
			// What changes is shown above the job, as `schedule edit` shows it.
			expect(said.at(-2)).toContain(
				'PROPOSED BY THE MODEL, NOT BY YOU — a change to the scheduled job alert',
			)
			expect(said.at(-2)).toMatch(
				/Changed since it was last confirmed\n {2}- When {8}every 2 minutes/,
			)
			expect(said.at(-2)).toContain('+ When        every 5 minutes')
			expect(said.at(-2)).toContain('+ Prompt  Show the alert twice.')
			expect(said.at(-2)).not.toContain('THE PERMISSIONS CHANGE')
			expect(questions.at(-1)?.options.map((o) => o.id)).toEqual(['cancel', 'save'])
			const history = readHistory(sb.paths, after?.id as string)
			expect(history.map((r) => (r.kind === 'job' ? r.action : r.kind))).toEqual([
				'created',
				'edited',
			])
			const edited = history.at(-1)
			expect(edited?.kind === 'job' && edited.by).toBe('tool')
			expect(edited?.kind === 'job' && edited.changes).toContain('+ When        every 5 minutes')
		})

		it('changes nothing unless the operator saves', async () => {
			await host('create').tool.execute(every2, {} as never)
			const [before] = listJobs(sb.paths).jobs
			const result = await host('cancel').tool.execute(
				{ action: 'update', job: 'alert', when: 'every 5m' },
				{} as never,
			)
			expect(result.success).toBe(false)
			expect(result.data).toEqual({ cancelled: true })
			expect(listJobs(sb.paths).jobs[0]).toEqual(before)
		})

		it('says so when the permissions change, and they are what the job runs under after', async () => {
			await host('create').tool.execute(every2, {} as never)
			const { tool, said } = host('save')
			const result = await tool.execute(
				{
					action: 'update',
					job: 'alert',
					permissions: {
						preset: 'edit-in-folder',
						rules: { bash: { 'powershell.exe -NoProfile -Command*': 'allow' } },
						unmatched: 'deny',
					},
				},
				{} as never,
			)
			expect(result.success).toBe(true)
			expect(said.at(-2)).toContain('THE PERMISSIONS CHANGE')
			expect(said.at(-2)).toMatch(/\+ bash "powershell\.exe -NoProfile -Command\*": allow/)
			const [job] = listJobs(sb.paths).jobs
			expect(job?.permissions.rules.bash).toEqual({
				'powershell.exe -NoProfile -Command*': 'allow',
			})
			expect(job && confirmationHolds(job)).toBe(true)
		})

		it('keeps a paused job paused', async () => {
			await host('create-paused').tool.execute(every2, {} as never)
			await host('save').tool.execute(
				{ action: 'update', job: 'alert', when: 'every 5m' },
				{} as never,
			)
			expect(listJobs(sb.paths).jobs[0]?.state).toBe('paused')
		})

		it('refuses what changes nothing, a time zone alone on a schedule that has none, and a job that moved on', async () => {
			await host('create').tool.execute(every2, {} as never)
			const { tool } = host('save')
			expect(
				(await tool.execute({ action: 'update', job: 'alert', when: 'every 2m' }, {} as never))
					.error,
			).toMatch(/changes nothing/)
			expect(
				(await tool.execute({ action: 'update', job: 'alert', tz: 'Europe/Istanbul' }, {} as never))
					.error,
			).toMatch(/only a cron schedule/)
			// The job is changed elsewhere while the operator is being asked.
			const racing = createScheduleToolHost({
				home: () => sb.home,
				cwd: () => sb.project,
				extraRoots: () => [],
				model: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
				config: () => ({}),
				sessionId: () => undefined,
				say: () => {},
				ask: async () => {
					const job = listJobs(sb.paths).jobs[0]
					if (job) updateJob(sb.paths, job.id, job.revision, (j) => ({ ...j, prompt: 'meanwhile' }))
					return { kind: 'answer', selectedOptionIds: ['save'] }
				},
			})
			const [raced] = buildScheduleTools(racing)
			const lost = await raced?.execute(
				{ action: 'update', job: 'alert', when: 'every 5m' },
				{} as never,
			)
			expect(lost?.error).toMatch(/changed while the operator was being asked/)
			expect(readJob(sb.paths, listJobs(sb.paths).jobs[0]?.id as string)?.prompt).toBe('meanwhile')
		})
	})

	it('refuses a folder the CLI would refuse, and lists other folders without prompts', async () => {
		const { tool } = host('create')
		const refused = await tool.execute({ ...input, folder: sb.home }, {} as never)
		expect(refused.error).toMatch(/NAMZU_HOME/)
		confirmedJob(sb, { name: 'elsewhere', folder: mkdtempSync(join(sb.osHome, 'other-')) })
		const listed = await tool.execute({ action: 'list', allFolders: true }, {} as never)
		const jobs = (listed.data as { jobs: { name: string; prompt?: string }[] }).jobs
		expect(jobs.find((j) => j.name === 'elsewhere')?.prompt).toBeUndefined()
	})

	describe('a model-proposed script/script+agent job', () => {
		const scriptInput = {
			action: 'create',
			name: 'ticker',
			kind: 'script',
			script: { body: 'echo hi', shell: 'bash' },
			when: 'every 1m',
			permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
		}

		it('shows the exact script text on its own confirmation screen, verified before it is shown', async () => {
			const { tool, said } = host('create')
			const result = await tool.execute(scriptInput, {} as never)
			expect(result.success).toBe(true)
			expect(said[0]).toContain('Script (exactly as it will run, bash')
			expect(said[0]).toContain('echo hi')
			expect(said[0]).not.toContain('Prompt (exactly as the run will read it)')
			const [job] = listJobs(sb.paths).jobs
			expect(job?.runKind).toBe('script')
			expect(job?.script).toMatchObject({ body: 'echo hi', shell: 'bash' })
			expect(job?.prompt).toBe('')
		})

		it('refuses a script the floor denies before any confirmation is shown, the same as schedule add', async () => {
			const { tool, said } = host('create')
			const result = await tool.execute(
				{
					...scriptInput,
					script: { body: 'systemctl --user stop namzu-scheduler', shell: 'bash' },
				},
				{} as never,
			)
			expect(result.success).toBe(false)
			expect(result.error).toMatch(/scheduled-run floor refused/)
			expect(said).toEqual([])
			expect(listJobs(sb.paths).jobs).toHaveLength(0)
		})

		it('an update keeps the job’s runKind and script when the model does not touch them', async () => {
			expect((await host('create').tool.execute(scriptInput, {} as never)).success).toBe(true)
			const { tool } = host('save')
			const result = await tool.execute(
				{ action: 'update', job: 'ticker', when: 'every 5m' },
				{} as never,
			)
			expect(result.success).toBe(true)
			const job = listJobs(sb.paths).jobs.find((j) => j.name === 'ticker')
			expect(readJob(sb.paths, job?.id as string)?.runKind).toBe('script')
			expect(readJob(sb.paths, job?.id as string)?.script).toMatchObject({ body: 'echo hi' })
		})

		// A UX/security review found that `update` accepted `kind`/`script` in
		// its input schema but silently dropped both from the change it
		// actually applied — reporting success with no error or warning that
		// the model's new script was ignored (`schedule-tool.ts`'s `CHANGEABLE`
		// list, and `updateRequest` here, never named them).
		it('an update actually changes the script body, verified fresh and shown in full', async () => {
			expect((await host('create').tool.execute(scriptInput, {} as never)).success).toBe(true)
			const { tool, said } = host('save')
			const result = await tool.execute(
				{
					action: 'update',
					job: 'ticker',
					script: { body: 'echo bye', shell: 'bash' },
				},
				{} as never,
			)
			expect(result.success).toBe(true)
			expect(result.data).toMatchObject({
				changes: expect.arrayContaining([expect.stringContaining('echo bye')]),
			})
			expect(said.at(-2)).toContain('Script (exactly as it will run, bash')
			expect(said.at(-2)).toContain('│ echo bye')
			// The old body shows only as what changed, not as the script's text.
			expect(said.at(-2)).toContain('- Script  echo hi')
			expect(said.at(-2)).toContain('+ Script  echo bye')
			const job = listJobs(sb.paths).jobs.find((j) => j.name === 'ticker')
			expect(readJob(sb.paths, job?.id as string)?.script).toMatchObject({ body: 'echo bye' })
		})

		it('an update refuses a script the floor denies, the same as a new one would be, before showing anything', async () => {
			expect((await host('create').tool.execute(scriptInput, {} as never)).success).toBe(true)
			const { tool, said } = host('save')
			const result = await tool.execute(
				{
					action: 'update',
					job: 'ticker',
					script: { body: 'systemctl --user stop namzu-scheduler', shell: 'bash' },
				},
				{} as never,
			)
			expect(result.success).toBe(false)
			expect(result.error).toMatch(/scheduled-run floor refused/)
			expect(said).toEqual([])
			const job = listJobs(sb.paths).jobs.find((j) => j.name === 'ticker')
			expect(readJob(sb.paths, job?.id as string)?.script).toMatchObject({ body: 'echo hi' })
		})

		it('an update can change a job’s kind, going through the same static check and confirmation', async () => {
			expect((await host('create').tool.execute(scriptInput, {} as never)).success).toBe(true)
			const { tool, said } = host('save')
			const result = await tool.execute(
				{
					action: 'update',
					job: 'ticker',
					kind: 'script+agent',
					script: { body: 'echo hi', shell: 'bash' },
					prompt: 'summarise what changed',
				},
				{} as never,
			)
			expect(result.success).toBe(true)
			expect(said.at(-2)).toContain('Wake-gate script (exactly as it will run')
			const job = listJobs(sb.paths).jobs.find((j) => j.name === 'ticker')
			const stored = readJob(sb.paths, job?.id as string)
			expect(stored?.runKind).toBe('script+agent')
			expect(stored?.prompt).toBe('summarise what changed')
			expect(stored?.wakeGate).toMatchObject({ maxContextChars: expect.any(Number) })
		})
	})
})

describe('/loop', () => {
	it('fires only when idle, once for several missed intervals, and comes back on resume unless expired', async () => {
		const file = join(sb.root, 'loops.json')
		let now = Date.parse('2026-09-23T10:00:00Z')
		let idle = false
		const fired: string[] = []
		const make = () =>
			new SessionLoopScheduler({
				file: () => file,
				isIdle: () => idle,
				fire: (l) => fired.push(l.id),
				now: () => now,
			})
		const loops = make()
		const loop = await loops.create({
			interval: '5m',
			prompt: 'check the build',
			createdBy: 'operator',
		})
		now += 16 * 60_000
		loops.tick()
		expect(fired).toEqual([])
		idle = true
		loops.tick()
		loops.tick()
		expect(fired).toEqual([loop.id])
		const restored = make()
		expect(restored.list().map((l) => l.id)).toEqual([loop.id])
		now += 8 * 24 * 60 * 60_000
		expect(make().list()).toEqual([])
		await expect(
			loops.create({ interval: '30s', prompt: 'x', createdBy: 'operator' }),
		).rejects.toThrow(/1m/)
	})
})

describe('the startup line', () => {
	it('says nothing when nothing happened, and names waiting approvals and failures once', () => {
		expect(scheduleStartupLine(sb.home, sb.project)).toBeUndefined()
		const job = confirmedJob(sb)
		const at = new Date().toISOString()
		appendHistory(sb.paths, job.id, {
			v: 1,
			kind: 'run',
			at,
			runId: 'r',
			key: '1',
			trigger: 'scheduled',
			startedAt: at,
			status: 'failed',
			reason: 'provider credential expired',
		})
		const line = scheduleStartupLine(sb.home, sb.project, Date.now() + 1)
		expect(line).toMatch(/1 failed: nightly failed \(provider credential expired\)/)
		expect(line).toMatch(/not installed/)
		const again = scheduleStartupLine(sb.home, sb.project, Date.now() + 2)
		expect(again).not.toMatch(/failed/)
	})
})
