import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	DiskResidentAgenda,
	ResidentHost,
	type ResidentLearningState,
	type ResidentStepContext,
	generateRunId,
	hashResidentSkill,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseRunFlags } from '../../commands/run-flags.js'
import type { CommandContext } from '../../commands/types.js'
import type { NamzuCliConfig } from '../../config/schema.js'
import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import type { AgentEvent, AgentSessionOptions, SendOptions } from '../../tui/agent.js'
import { openSessions } from '../sessions/store.js'
import { ResidentCleanupUnconfirmedError } from './lifecycle-errors.js'
import { createResidentSessionStep } from './session-step.js'

const mocks = vi.hoisted(() => ({
	probe: vi.fn(),
	create: vi.fn(),
	attach: vi.fn(),
	shutdown: vi.fn(),
	close: vi.fn(),
	listener: vi.fn(),
}))
vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: mocks.probe,
	createAgentSession: mocks.create,
}))
vi.mock('../telemetry/session-export.js', () => ({ attachSessionExport: mocks.attach }))

const complete = { kind: 'complete', summary: 'Checked the evidence.' }
const signal = new AbortController().signal
let root: string

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'namzu-resident-session-'))
	vi.resetAllMocks()
	mocks.probe.mockResolvedValue({
		preferences: {
			version: 3,
			providers: [{ id: 'openai', model: 'configured-model' }],
			subagents: { active: [] },
		},
		detected: [],
	})
	mocks.create.mockResolvedValue(
		fakeAgentSession({
			close: mocks.close,
			send: () =>
				stream([{ kind: 'done', stopReason: 'end_turn', text: JSON.stringify(complete) }]),
		}),
	)
	mocks.attach.mockResolvedValue({
		listener: mocks.listener,
		shutdown: mocks.shutdown,
		disclosure: 'fixture export',
	})
})

afterEach(async () => {
	vi.restoreAllMocks()
	await rm(root, { recursive: true, force: true })
})

async function* stream(events: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
	yield* events
}

async function fixture(config: NamzuCliConfig = {}, args: readonly string[] = []) {
	const cwd = join(root, 'workspace')
	await mkdir(cwd, { recursive: true })
	const sessions = await openSessions(cwd, { stateRoot: join(root, 'state') })
	const ctx: CommandContext = {
		config,
		formatter: { name: 'text', print: vi.fn(), info: vi.fn(), error: vi.fn() },
	}
	const agenda = new DiskResidentAgenda(join(root, 'agenda'), {
		tenantId: sessions.tenantId,
		agentKey: 'test-resident',
	})
	const pursuit = await agenda.add(
		await agenda.create('Carefully check evidence.'),
		'Assess the retained evidence.',
	)
	const options = {
		ctx,
		cwd,
		sessions,
		flags: parseRunFlags(args),
		artifactsRoot: join(root, 'receipts'),
	}
	return { agenda, pursuit, options, step: () => createResidentSessionStep(options) }
}

async function receipt(artifactsRoot: string, name: string): Promise<Record<string, any>> {
	const claims = await readdir(artifactsRoot)
	expect(claims).toHaveLength(1)
	return JSON.parse(await readFile(join(artifactsRoot, claims[0], name), 'utf8'))
}

function creationOptions(): AgentSessionOptions {
	return mocks.create.mock.calls[0]?.[2] as AgentSessionOptions
}

describe('normal CLI runtime reaches a resident admission', () => {
	it('constructs no provider or receipts before admission, including idle and paused hosts', async () => {
		const f = await fixture()
		const step = f.step()
		expect(mocks.probe).not.toHaveBeenCalled()
		const host = new ResidentHost(f.agenda, step)
		await host.pause()
		expect(await host.run({ signal, maxSteps: 1 })).toMatchObject({ status: 'paused' })
		await host.resume()
		const state = (await f.agenda.read())!
		const execution = f.agenda.execution(f.pursuit.id)
		const claim = await execution.claim(state.pursuits[0].state, Date.now())
		await execution.settle(
			claim,
			{ kind: 'wait', summary: 'Waiting for evidence.', wakeAt: null },
			Date.now(),
		)
		expect(await host.run({ signal, maxSteps: 1 })).toMatchObject({ status: 'idle' })
		expect(mocks.probe).not.toHaveBeenCalled()
		expect(mocks.create).not.toHaveBeenCalled()
		await expect(stat(f.options.artifactsRoot)).rejects.toMatchObject({ code: 'ENOENT' })
	})

	it('forwards the whole configured session and flag overrides, with isolated run identity', async () => {
		const config: NamzuCliConfig = {
			permissions: { bash: 'deny' },
			mcpServers: { tools: { command: 'fixture-server' } },
			plugins: { enabled: true, allowedScopes: ['project'] },
			web: { search: 'off', fetch: true },
			hooks: { run_start: [{ command: 'fixture-hook' }] },
			compaction: { strategy: 'structured', contextWindowTokens: 24_000 },
			memory: { recall: true },
			limits: { maxIterations: 12, tokenBudget: 300 },
			sandbox: { enabled: true, workspace: 'working-directory' },
			additionalDirectories: ['../shared'],
			telemetry: { sessionExport: { destination: join(root, 'export.jsonl') } },
		}
		const f = await fixture(config, [
			'--provider',
			'anthropic',
			'--model',
			'chosen-model',
			'--effort',
			'low',
			'--max-iterations',
			'4',
			'--token-budget',
			'200',
			'--skills',
			'receipt-skill',
		])
		const skillDir = join(f.options.cwd, 'skills', 'receipt-skill')
		await mkdir(skillDir, { recursive: true })
		await writeFile(
			join(skillDir, 'SKILL.md'),
			'---\nname: receipt-skill\ndescription: fixture\n---\nPrefer retained source references.',
		)
		const send = vi.fn((_messages, _options: SendOptions | undefined) =>
			stream([
				{ kind: 'delta', text: '{"kind":"blocked","summary":"Rejected draft"}' },
				{
					kind: 'usage',
					totalTokens: 31,
					cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 31 },
				},
				{ kind: 'done', stopReason: 'end_turn', text: JSON.stringify(complete) },
			]),
		)
		mocks.create.mockImplementation(async () => fakeAgentSession({ send, close: mocks.close }))
		expect(await new ResidentHost(f.agenda, f.step()).run({ signal, maxSteps: 1 })).toMatchObject({
			status: 'limit',
			stepsSettled: 1,
		})
		expect(mocks.create.mock.calls[0][0].providers).toEqual([
			{ id: 'anthropic', model: 'chosen-model' },
		])
		const options = creationOptions()
		expect(options).toMatchObject({
			cwd: f.options.cwd,
			stateRoot: f.options.sessions.root,
			scope: {
				tenantId: f.options.sessions.tenantId,
				projectId: f.options.sessions.projectId,
				topicId: f.options.sessions.topicId,
			},
			permissionMode: 'plan',
			mcpServers: config.mcpServers,
			plugins: config.plugins,
			web: config.web,
			hooks: config.hooks,
			compaction: config.compaction,
			memory: config.memory,
			limits: { maxIterations: 4, tokenBudget: 200 },
			sandbox: config.sandbox,
			additionalDirectories: [join(root, 'shared')],
			onRunEvent: mocks.listener,
		})
		expect(options.rules).toHaveLength(1)
		expect(options).not.toHaveProperty('conversationSessions')
		expect(options).not.toHaveProperty('sessionGoals')
		expect(options).not.toHaveProperty('enableComputerUse')
		const sent = send.mock.calls[0][1]!
		expect(sent).toMatchObject({ effort: 'low', permissionMode: 'plan' })
		expect(sent.signal).toBeInstanceOf(AbortSignal)
		expect(sent.extraSystem).toContain('Prefer retained source references.')
		expect(sent.extraSystem).toContain('Carefully check evidence.')
		expect(sent.extraSystem).toContain(f.pursuit.state.objective)
		expect(sent.extraSystem).toContain('Only the saved summary continues')
		const start = await receipt(f.options.artifactsRoot, 'start.json')
		const finish = await receipt(f.options.artifactsRoot, 'finish.json')
		expect(start).toMatchObject({
			pursuitId: f.pursuit.id,
			sessionId: options.scope!.sessionId,
			runId: sent.runId,
			cwd: f.options.cwd,
			provider: 'mock',
			model: 'mock-model',
		})
		expect(finish).toMatchObject({
			decision: complete,
			stopReason: 'end_turn',
			error: null,
			usage: { totalTokens: 31, cost: { unpricedTokens: 31 } },
		})
		expect(JSON.stringify(finish)).not.toContain('Rejected draft')
		if (process.platform !== 'win32') {
			expect((await stat(join(f.options.artifactsRoot, start.claimId))).mode & 0o777).toBe(0o700)
			expect(
				(await stat(join(f.options.artifactsRoot, start.claimId, 'start.json'))).mode & 0o777,
			).toBe(0o600)
		}
		expect(mocks.close).toHaveBeenCalledOnce()
		expect(mocks.shutdown).toHaveBeenCalledOnce()
	})

	it.each([['--permission-mode', 'strict'], ['--yolo']])(
		'honors explicit permission flags %j',
		async (...args) => {
			const f = await fixture({}, args)
			await new ResidentHost(f.agenda, f.step()).run({ signal, maxSteps: 1 })
			expect(creationOptions().permissionMode).toBe(args[0] === '--yolo' ? 'auto' : 'strict')
		},
	)

	it('retains only the prior summary when a later admission opens another isolated session', async () => {
		const f = await fixture()
		const sent: SendOptions[] = []
		mocks.create.mockImplementation(async () =>
			fakeAgentSession({
				close: mocks.close,
				send: (_messages, options) => {
					sent.push(options!)
					const decision =
						sent.length === 1
							? { kind: 'wait', summary: 'First step evidence.', wakeAfterMs: null }
							: complete
					return stream([{ kind: 'done', stopReason: 'end_turn', text: JSON.stringify(decision) }])
				},
			}),
		)
		const host = new ResidentHost(f.agenda, f.step())
		await host.run({ signal, maxSteps: 1 })
		await host.wake(f.pursuit.id, 'Continue from the retained evidence.')
		await host.run({ signal, maxSteps: 1 })
		expect(sent).toHaveLength(2)
		expect(sent[1].extraSystem).toContain('First step evidence.')
		expect(sent[0].runId).not.toBe(sent[1].runId)
		expect(mocks.create.mock.calls[0][2].scope.sessionId).not.toBe(
			mocks.create.mock.calls[1][2].scope.sessionId,
		)
		expect(mocks.close).toHaveBeenCalledTimes(2)
		expect(await readdir(f.options.artifactsRoot)).toHaveLength(2)
	})

	it('publishes start before send and finish only after session and export drain', async () => {
		const f = await fixture({
			telemetry: { sessionExport: { destination: join(root, 'export.jsonl') } },
		})
		const order: string[] = []
		mocks.create.mockResolvedValue(
			fakeAgentSession({
				send: () =>
					(async function* () {
						expect(await receipt(f.options.artifactsRoot, 'start.json')).toMatchObject({
							pursuitId: f.pursuit.id,
						})
						order.push('send')
						yield { kind: 'done', stopReason: 'end_turn', text: JSON.stringify(complete) } as const
					})(),
				close: async () => {
					const start = await receipt(f.options.artifactsRoot, 'start.json')
					await expect(
						stat(join(f.options.artifactsRoot, start.claimId, 'finish.json')),
					).rejects.toMatchObject({ code: 'ENOENT' })
					order.push('close')
				},
			}),
		)
		mocks.shutdown.mockImplementation(async () => {
			order.push('export')
		})
		await new ResidentHost(f.agenda, f.step()).run({ signal, maxSteps: 1 })
		expect(order).toEqual(['send', 'close', 'export'])
		expect(await receipt(f.options.artifactsRoot, 'finish.json')).toMatchObject({
			decision: complete,
		})
	})
})

describe('the SDK reviewer owns decision repair and configured verification', () => {
	it('rejects malformed answers inside the normal answer reviewer and still enforces the command gate', async () => {
		const f = await fixture({}, [
			'--gate',
			`${process.execPath} -e "process.exit(1)"`,
			'--gate-retries',
			'2',
		])
		await new ResidentHost(f.agenda, f.step()).run({ signal, maxSteps: 1 })
		const { reviewAnswer, maxAnswerReviews } = creationOptions()
		expect(maxAnswerReviews).toBe(2)
		const context = { runId: generateRunId(), iteration: 1, messages: [], signal }
		expect(await reviewAnswer!('done', context)).toMatchObject({
			accept: false,
			feedback: expect.stringContaining('JSON object'),
		})
		expect(await reviewAnswer!(JSON.stringify(complete), context)).toMatchObject({ accept: false })
	})

	it.each([
		'{}',
		'[]',
		'```json\n{"kind":"complete","summary":"Done"}\n```',
		JSON.stringify({ kind: 'complete', summary: ' ' }),
		JSON.stringify({ kind: 'complete', summary: 'x'.repeat(8_001) }),
		JSON.stringify({ kind: 'complete', summary: 'Done', tool: 'bash' }),
		JSON.stringify({ kind: 'wait', summary: 'Later' }),
		JSON.stringify({ kind: 'wait', summary: 'Later', wakeAfterMs: -1 }),
		JSON.stringify({ kind: 'wait', summary: 'Later', wakeAfterMs: 0.5 }),
		JSON.stringify({ kind: 'wait', summary: 'Later', wakeAfterMs: 86_400_001 }),
		' '.repeat(32_001),
	])('rejects invalid settled output without host retries (%#)', async (text) => {
		const f = await fixture()
		mocks.create.mockResolvedValue(
			fakeAgentSession({
				close: mocks.close,
				send: () => stream([{ kind: 'done', stopReason: 'end_turn', text }]),
			}),
		)
		await expect(new ResidentHost(f.agenda, f.step()).run({ signal, maxSteps: 1 })).rejects.toThrow(
			'Resident',
		)
		expect((await f.agenda.read())!.pursuits[0].state.phase).toBe('running')
		expect(mocks.create).toHaveBeenCalledOnce()
		expect(mocks.close).toHaveBeenCalledOnce()
		expect(await receipt(f.options.artifactsRoot, 'finish.json')).toMatchObject({
			decision: null,
			error: expect.any(String),
		})
	})

	it.each([null, 0, 2_000])(
		'accepts a bounded wait delay %j after cleanup',
		async (wakeAfterMs) => {
			const f = await fixture()
			mocks.create.mockResolvedValue(
				fakeAgentSession({
					close: mocks.close,
					send: () =>
						stream([
							{
								kind: 'done',
								stopReason: 'end_turn',
								text: JSON.stringify({
									kind: 'wait',
									summary: 'More useful work remains.',
									wakeAfterMs,
								}),
							},
						]),
				}),
			)
			const before = Date.now()
			await new ResidentHost(f.agenda, f.step()).run({ signal, maxSteps: 1 })
			const state = (await f.agenda.read())!.pursuits[0].state
			expect(state.phase).toBe('waiting')
			if (wakeAfterMs === null) expect(state.wakeAt).toBeNull()
			else expect(state.wakeAt).toBeGreaterThanOrEqual(before + Math.max(1_000, wakeAfterMs))
		},
	)
})

describe('failed or interrupted work stays unresolved', () => {
	it.each([
		[{ kind: 'delta', text: JSON.stringify(complete) }],
		[{ kind: 'done', stopReason: 'end_turn' }],
		[{ kind: 'done', stopReason: 'end_turn', text: '' }],
		[{ kind: 'done', stopReason: 'max_iterations', text: JSON.stringify(complete) }],
		[{ kind: 'done', stopReason: 'token_budget', text: JSON.stringify(complete) }],
		[
			{ kind: 'error', message: 'Provider failed' },
			{ kind: 'done', stopReason: 'end_turn', text: JSON.stringify(complete) },
		],
		[{ kind: 'paused', runId: 'run', checkpointId: 'checkpoint', reason: 'Provider unavailable' }],
	] satisfies AgentEvent[][])(
		'keeps the claim for an unfinished stream (%#)',
		async (...events) => {
			const f = await fixture()
			mocks.create.mockResolvedValue(
				fakeAgentSession({ close: mocks.close, send: () => stream(events) }),
			)
			const host = new ResidentHost(f.agenda, f.step())
			await expect(host.run({ signal, maxSteps: 1 })).rejects.toThrow()
			expect((await f.agenda.read())!.pursuits[0].state.phase).toBe('running')
			expect(await host.run({ signal, maxSteps: 1 })).toMatchObject({ status: 'unresolved' })
			expect(mocks.create).toHaveBeenCalledOnce()
			expect(mocks.close).toHaveBeenCalledOnce()
		},
	)

	it('forwards cancellation and waits for cleanup before reporting failure', async () => {
		const f = await fixture()
		const abort = new AbortController()
		let drained = false
		mocks.create.mockResolvedValue(
			fakeAgentSession({
				send: (_messages, opts) =>
					(async function* () {
						abort.abort(new DOMException('Interrupted resident fixture', 'AbortError'))
						expect(opts!.signal!.aborted).toBe(true)
						yield { kind: 'done', stopReason: 'end_turn', text: JSON.stringify(complete) } as const
					})(),
				close: async () => {
					await Promise.resolve()
					drained = true
				},
			}),
		)
		const result = await new ResidentHost(f.agenda, f.step()).run({
			signal: abort.signal,
			maxSteps: 1,
		})
		expect(result).toMatchObject({ status: 'cancelled', stepsSettled: 0 })
		expect(drained).toBe(true)
		expect((await f.agenda.read())!.pursuits[0].state.phase).toBe('running')
		expect(await receipt(f.options.artifactsRoot, 'finish.json')).toMatchObject({
			decision: null,
			error: expect.stringContaining('Interrupted resident fixture'),
		})
	})

	it.each(['session', 'telemetry'])(
		'reports cleanup unconfirmed when %s cleanup fails after a valid answer',
		async (resource) => {
			const f = await fixture({
				telemetry: { sessionExport: { destination: join(root, 'export.jsonl') } },
			})
			const failure = new Error(`${resource} cleanup failed`)
			;(resource === 'session' ? mocks.close : mocks.shutdown).mockRejectedValue(failure)
			const error = await new ResidentHost(f.agenda, f.step())
				.run({ signal, maxSteps: 1 })
				.catch((error: unknown) => error)
			expect(error).toBeInstanceOf(ResidentCleanupUnconfirmedError)
			expect(error).toMatchObject({
				message: expect.stringContaining('cleanup is unconfirmed'),
				errors: [failure],
			})
			expect(mocks.close).toHaveBeenCalledOnce()
			expect(mocks.shutdown).toHaveBeenCalledOnce()
			expect((await f.agenda.read())!.pursuits[0].state.phase).toBe('running')
			expect(await receipt(f.options.artifactsRoot, 'finish.json')).toMatchObject({
				decision: null,
				error: `${resource} cleanup failed`,
				cleanup: 'unconfirmed',
			})
		},
	)

	it('records boot failure and drains an already attached export', async () => {
		const f = await fixture({
			telemetry: { sessionExport: { destination: join(root, 'export.jsonl') } },
		})
		mocks.create.mockRejectedValue(new Error('provider boot failed'))
		await expect(
			new ResidentHost(f.agenda, f.step()).run({ signal, maxSteps: 1 }),
		).rejects.toBeInstanceOf(ResidentCleanupUnconfirmedError)
		expect(mocks.shutdown).toHaveBeenCalledOnce()
		expect(mocks.close).not.toHaveBeenCalled()
		expect(await receipt(f.options.artifactsRoot, 'start.json')).toMatchObject({
			provider: null,
			model: null,
		})
		expect(await receipt(f.options.artifactsRoot, 'finish.json')).toMatchObject({
			decision: null,
			error: 'provider boot failed',
			cleanup: 'unconfirmed',
		})
	})

	it('does not certify a refused constructor whose partial cleanup is unavailable', async () => {
		const f = await fixture()
		const send = vi.fn(() => stream([]))
		mocks.create.mockResolvedValue(
			fakeAgentSession({
				hasProvider: false,
				errorHint: 'Plugin startup refused',
				close: mocks.close,
				send,
			}),
		)
		await expect(
			new ResidentHost(f.agenda, f.step()).run({ signal, maxSteps: 1 }),
		).rejects.toBeInstanceOf(ResidentCleanupUnconfirmedError)
		expect(mocks.close).toHaveBeenCalledOnce()
		expect(send).not.toHaveBeenCalled()
		expect(await receipt(f.options.artifactsRoot, 'finish.json')).toMatchObject({
			decision: null,
			error: 'Plugin startup refused',
			cleanup: 'unconfirmed',
		})
	})

	it('keeps a failure before session construction distinct from unconfirmed cleanup', async () => {
		const f = await fixture()
		const failure = new Error('Preferences could not be read')
		mocks.probe.mockRejectedValue(failure)
		await expect(new ResidentHost(f.agenda, f.step()).run({ signal, maxSteps: 1 })).rejects.toBe(
			failure,
		)
		expect(mocks.create).not.toHaveBeenCalled()
		expect(await receipt(f.options.artifactsRoot, 'finish.json')).toMatchObject({
			decision: null,
			error: failure.message,
			cleanup: 'confirmed',
		})
	})

	it('exposes cleanup failure at the callback boundary even when cancellation hides it at the host', async () => {
		const f = await fixture()
		const abort = new AbortController()
		const failure = new Error('Interrupted session cleanup failed')
		mocks.close.mockRejectedValue(failure)
		mocks.create.mockResolvedValue(
			fakeAgentSession({
				close: mocks.close,
				send: () =>
					(async function* () {
						abort.abort(new Error('Stop requested'))
						yield { kind: 'done', stopReason: 'end_turn', text: JSON.stringify(complete) } as const
					})(),
			}),
		)
		const step = f.step()
		let caught: unknown
		const result = await new ResidentHost(f.agenda, async (...args) => {
			try {
				return await step(...args)
			} catch (error) {
				caught = error
				throw error
			}
		}).run({ signal: abort.signal, maxSteps: 1 })
		expect(result).toMatchObject({ status: 'cancelled', stepsSettled: 0 })
		expect(caught).toBeInstanceOf(ResidentCleanupUnconfirmedError)
		expect(caught).toMatchObject({ errors: [abort.signal.reason, failure] })
		expect(await receipt(f.options.artifactsRoot, 'finish.json')).toMatchObject({
			decision: null,
			cleanup: 'unconfirmed',
		})
	})

	it('preserves unconfirmed cleanup when the finish receipt cannot be published', async () => {
		const f = await fixture()
		const failure = new Error('Session cleanup failed')
		mocks.close.mockImplementation(async () => {
			const [claimId] = await readdir(f.options.artifactsRoot)
			const artifacts = join(f.options.artifactsRoot, claimId)
			await rm(artifacts, { recursive: true })
			await writeFile(artifacts, 'Receipt directory became unavailable')
			throw failure
		})
		const error = await new ResidentHost(f.agenda, f.step())
			.run({ signal, maxSteps: 1 })
			.catch((error: unknown) => error)
		expect(error).toBeInstanceOf(ResidentCleanupUnconfirmedError)
		expect(error).toMatchObject({ errors: [failure, expect.any(Error)] })
		expect((await f.agenda.read())!.pursuits[0].state.phase).toBe('running')
	})
})

it('projects saved summaries and approved learning without changing session authority', async () => {
	const f = await fixture()
	const candidate = {
		name: 'check-evidence',
		description: 'Check source evidence.',
		body: 'Compare each claim with its source.',
	}
	const hash = hashResidentSkill(candidate)
	const evidence = { key: 'verified', source: 'host', reason: 'Approved fixture' }
	const learning: ResidentLearningState = {
		revision: 1,
		identity: { text: 'A concise researcher.', evidence },
		preferences: [{ key: 'language', value: 'Turkish', evidence }],
		skills: [
			{
				...candidate,
				hash,
				evidence,
				verification: {
					baselineHash: 'none',
					candidateHash: hash,
					evidenceDigest: 'a'.repeat(64),
					verificationTasks: 5,
					confirmationTasks: 5,
				},
			},
		],
		lastChange: evidence,
	}
	const execution = f.agenda.execution(f.pursuit.id)
	const admitted = await execution.claim(f.pursuit.state, Date.now())
	const waiting = await execution.settle(
		admitted,
		{ kind: 'wait', summary: 'Prior evidence was retained.', wakeAt: null },
		Date.now(),
	)
	const awake = await f.agenda.wake(f.pursuit.id, waiting, 'A new source arrived.', Date.now())
	const claim = await execution.claim(awake, Date.now())
	let sent: SendOptions | undefined
	mocks.create.mockResolvedValue(
		fakeAgentSession({
			close: mocks.close,
			send: (_messages, opts) => {
				sent = opts
				return stream([{ kind: 'done', stopReason: 'end_turn', text: JSON.stringify(complete) }])
			},
		}),
	)
	await f.step()({ id: f.pursuit.id, state: claim }, signal, {
		agendaRevision: 1,
		learning,
	} satisfies ResidentStepContext)
	expect(sent!.signal).toBe(signal)
	expect(sent!.extraSystem).toContain('Prior evidence was retained.')
	expect(sent!.extraSystem).toContain('A new source arrived.')
	expect(sent!.extraSystem).toContain('A concise researcher.')
	expect(sent!.extraSystem).toContain('Turkish')
	expect(sent!.extraSystem).toContain(candidate.body)
	expect(creationOptions().permissionMode).toBe('plan')
	expect(creationOptions()).not.toHaveProperty('sessionGoals')
})

it.each([
	['--continue'],
	['--session', 'id'],
	['--resume', 'id'],
	['--wait-for-provider', '1s'],
	['--gate-retries', '3'],
	['--wat'],
])('rejects unsupported flags before admission: %j', async (...args) => {
	const f = await fixture({}, args)
	expect(() => f.step()).toThrow()
	expect(mocks.probe).not.toHaveBeenCalled()
	expect((await f.agenda.read())!.pursuits[0].state.stepsAdmitted).toBe(0)
})

it('refuses configured provider replay before admission', async () => {
	const f = await fixture({ limits: { waitForProviderMs: 1_000 } })
	expect(() => f.step()).toThrow('limits.waitForProviderMs')
	expect(mocks.probe).not.toHaveBeenCalled()
})
