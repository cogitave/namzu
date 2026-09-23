/**
 * The TUI's scheduler surfaces: answering a parked scheduled run under the
 * job's rules, the model-tool host that computes what it shows, `/loop`'s
 * timing, and the startup line.
 */

import { existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { NOOP_LOGGER, buildScheduleTools } from '@namzu/sdk'
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
import { ScheduleDaemon } from '../../schedule/daemon/daemon.js'
import { runFire } from '../../schedule/fire/fire.js'
import { appendHistory, foldHistory, readHistory } from '../../schedule/store/history.js'
import { listJobs } from '../../schedule/store/jobs.js'
import { readState } from '../../schedule/store/state.js'
import {
	type PermissionRequest,
	type ScreenPermissionRequest,
	createAgentSession,
} from '../agent.js'
import { SessionLoopScheduler } from './loop-host.js'
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

const agent = {
	probeAgentSession: async () => ({
		preferences: null,
		needsRepickReason: null,
		detected: [DEEPSEEK],
		credentialGap: null,
	}),
	createAgentSession,
}

/** Run the job once until it parks, as the daemon would, and record the park in its state. */
async function parkedRun(marker: string) {
	const job = confirmedJob(sb, { permissions: { preset: 'edit-in-folder' } })
	responses.push(() => completion({ name: 'bash', input: { command: `touch ${marker}` } }))
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
				{ agent, keepLogging: true },
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
		const scheduled = await prepareScheduledResume({
			home: sb.home,
			sessionId: run.sessionId as string,
			operatorMode: 'auto',
			environment: { cwd: sb.project, roots: [], sandboxed: false },
			ask,
			say: () => {},
		})
		expect(scheduled?.pendingDecision).toEqual({ action: 'approve_tools' })
		expect(scheduled?.permissionMode).toBe('prompt')
		expect(asked[0]?.toolCalls[0]?.name).toBe('bash')

		// After the parked batch's result, the model asks for two more commands.
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>(async (_input, init) => {
				const body = String(init?.body ?? '')
				if (!body.includes('call_2'))
					return completion({ name: 'bash', input: { command: `touch ${second}` }, id: 'call_2' })
				if (!body.includes('call_3'))
					return completion({ name: 'bash', input: { command: `touch ${third}` }, id: 'call_3' })
				return completion()
			}),
		)
		// The TUI's session for this folder: its own rules would allow bash outright.
		const sessions = await openSessions(sb.project, { stateRoot: sb.home })
		const session = await createAgentSession(
			{ version: 3, providers: [{ id: 'deepseek' }], subagents: { active: [] } },
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
		// Every prompt was put to the screen as batch-only: no "allow all" on it.
		expect(asked.every((request) => request.batchOnly === true)).toBe(true)

		await daemon.tick()
		const record = foldHistory(readHistory(sb.paths, job.id)).find(
			(r) => r.kind === 'run' && r.runId === run.runId,
		)
		expect(record).toMatchObject({ status: 'completed' })
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
		const attempt = (environment: { cwd: string; roots: string[]; sandboxed: boolean }) =>
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
		expect(asked).toHaveLength(0)
	})

	it('names every way a session differs from the job', () => {
		const other = mkdtempSync(join(sb.osHome, 'extra-'))
		const job = confirmedJob(sb, {
			permissions: { preset: 'read-only', execution: 'sandbox', additionalDirectories: [other] },
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
	function host(answer: string) {
		const said: string[] = []
		const questions: { options: { id: string }[] }[] = []
		const h = createScheduleToolHost({
			home: () => sb.home,
			cwd: () => sb.project,
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

	it('refuses a folder the CLI would refuse, and lists other folders without prompts', async () => {
		const { tool } = host('create')
		const refused = await tool.execute({ ...input, folder: sb.home }, {} as never)
		expect(refused.error).toMatch(/NAMZU_HOME/)
		confirmedJob(sb, { name: 'elsewhere', folder: mkdtempSync(join(sb.osHome, 'other-')) })
		const listed = await tool.execute({ action: 'list', allFolders: true }, {} as never)
		const jobs = (listed.data as { jobs: { name: string; prompt?: string }[] }).jobs
		expect(jobs.find((j) => j.name === 'elsewhere')?.prompt).toBeUndefined()
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
