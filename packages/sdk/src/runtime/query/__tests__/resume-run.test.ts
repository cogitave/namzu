import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { clearToolResult } from '../../../compaction/tool-result-editing.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import {
	InMemorySessionLog,
	type SessionLease,
	type SessionLog,
} from '../../../store/session-log/index.js'
import { EditTool } from '../../../tools/builtins/edit.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import { WriteFileTool } from '../../../tools/builtins/write-file.js'
import { createFileReadTracker } from '../../../tools/file-read-tracker.js'
import type { HITLDecisionRequest } from '../../../types/hitl/index.js'
import type { SessionId, TenantId, TurnId } from '../../../types/ids/index.js'
import {
	type Message,
	type ToolMessage,
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { CheckpointManager } from '../checkpoint.js'
import { type ResumeSessionParams, resumeSession } from '../resume-session.js'
import type { TurnStateScope } from '../turn-state.js'
import {
	type CheckpointedSession,
	TEST_SCOPE,
	addCheckpoint,
	checkpointRecords,
	checkpointStoreFor,
	sessionWithCheckpoint,
} from './support/session.js'

/**
 * The pieces of a cross-process resume all existed and nothing joined them.
 * `CheckpointManager` wrote the history, budgets, working state and any
 * park; `loadTurnState` read them back; `query` accepted `turnId` +
 * `resumeFromCheckpoint` and restored all of it. But `resumeFromCheckpoint`
 * had no caller anywhere outside `packages/sdk/src`, so the whole path
 * shipped untravelled — every host was expected to write the same wiring
 * and none did.
 *
 * These cover the join, and especially its two refusals: a resume must not
 * quietly become a fresh turn under a recycled id, and it must not step past
 * a park without the answer that park is waiting for.
 */

const SCOPE: TurnStateScope = {
	...TEST_SCOPE,
	sessionId: 'a89fa2a8-3672-4495-9a89-ad85ddaf0b50' as SessionId,
	turnId: '9dbf5ebc-ce42-425d-aeee-c60e281113c2' as TurnId,
}

const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

/**
 * The session a process left behind: one turn with `messages` recorded and
 * a committed checkpoint that says 120 tokens were spent. `release` gives
 * the writer lease up, as a process that died would once it expired.
 */
function interruptedSession(
	options: { readonly messages?: readonly Message[]; readonly release?: boolean } = {},
): Promise<CheckpointedSession> {
	return sessionWithCheckpoint({
		sessionId: SCOPE.sessionId,
		turnId: SCOPE.turnId,
		messages: options.messages ?? [createUserMessage('the work so far')],
		document: {
			tokenUsage: { ...ZERO_USAGE, promptTokens: 120, totalTokens: 120 },
			costInfo: { totalCost: 0.4, cacheDiscount: 0, unpricedTokens: 0 },
			guards: { iteration: 2, elapsedMs: 9_000 },
		},
		release: options.release ?? true,
	})
}

let workdirs: string[] = []

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs = []
})

async function mkWorkdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-resume-run-'))
	workdirs.push(dir)
	// Canonical, because the tools key the observation ledger canonically and
	// `os.tmpdir()` is itself a symlink on macOS. A run whose working directory
	// is a link is a run whose ledger nothing here would find.
	return realpath(dir)
}

/**
 * A provider and registry that make the run actually ITERATE.
 *
 * A text-only turn finishes before the iteration checkpoint phase runs, so
 * nothing is written and a fence has nothing to be presented on — measured:
 * zero `writeCheckpoint` calls for the whole resume. A claim test built on
 * that shape cannot fail, whatever the wiring does. One tool call and a
 * closing turn is the shortest run that checkpoints.
 */
function toolCallingProvider(): MockLLMProvider {
	return new MockLLMProvider({
		turns: [{ toolCalls: [{ name: 'echo', args: { text: 'hi' } }] }, { text: 'continued' }],
	})
}

function registryWithEcho(): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register({
		name: 'echo',
		description: 'echo the text back',
		inputSchema: z.object({ text: z.string() }),
		execute: async () => ({ success: true, output: 'hi' }),
	})
	return tools
}

async function baseParams(session: {
	readonly log: SessionLog
	readonly store: CheckpointedSession['store']
}) {
	return {
		scope: SCOPE,
		sessionLog: session.log,
		checkpointStore: session.store,
		provider: new MockLLMProvider({ turns: [{ text: 'continued' }] }),
		tools: new ToolRegistry(),
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 2,
			maxResponseTokens: 256,
		},
		agentId: 'agent_resume',
		agentName: 'Resume Agent',
		workingDirectory: await mkWorkdir(),
		sessionId: SCOPE.sessionId,
		topicId: SCOPE.topicId,
		projectId: SCOPE.projectId,
		tenantId: SCOPE.tenantId,
		// Required by the contract, and rightly so: a resume that lands on a
		// park has to have somewhere to ask.
		resumeHandler: async () => ({ action: 'continue' as const }),
	}
}

describe('a turn is picked back up from its session log', () => {
	it('continues the same turn id rather than starting a new one', async () => {
		const session = await interruptedSession()

		const outcome = await resumeSession(await baseParams(session))

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		// The whole point: a resume is the same turn in a different process,
		// so its id, budgets and trace all have to carry across.
		expect(outcome.turn.id).toBe(SCOPE.turnId)
		expect(outcome.state.checkpointId).toBe(session.checkpointId)
	})

	it.each([
		['sessionId', '73321b05-67f6-4328-93cc-5bc436e22727' as SessionId],
		['topicId', '25c69d31-6765-49e0-848e-a189eca3c19a' as TopicId],
		['projectId', 'dd33c142-d050-42d8-9d06-6167dd8b27d1' as ProjectId],
		['tenantId', '03857320-0500-482a-85e0-add350d8ffdd' as TenantId],
		['parentSessionId', 'e53b7b64-32f3-4439-8cb1-6c1d13ec5d96' as SessionId],
	] as const)('refuses a mismatched %s before provider work', async (field, value) => {
		const session = await interruptedSession()
		const base = await baseParams(session)
		const candidate = { ...base, [field]: value } as ResumeSessionParams

		await expect(resumeSession(candidate)).rejects.toMatchObject({
			code: 'invalid_config',
			details: { fields: [field] },
		})
		expect((candidate.provider as MockLLMProvider).requests).toHaveLength(0)
	})

	it('finds no checkpoint for a scope naming another turn of the session', async () => {
		const session = await interruptedSession()
		const candidate = {
			...(await baseParams(session)),
			scope: { ...SCOPE, turnId: 'a2c2d074-2ed9-4653-b4b9-7d0589265864' as TurnId },
		}

		await expect(resumeSession(candidate)).resolves.toEqual({
			resumed: false,
			reason: 'no-checkpoint',
		})
		expect(candidate.provider.requests).toHaveLength(0)
	})

	it('repairs only abandoned checkpoint tool history before the resumed provider call', async () => {
		const abandonedCall = {
			id: 'call-abandoned',
			type: 'function' as const,
			function: { name: 'charge_card', arguments: '{"amount":42}' },
		}
		const assistant = createAssistantMessage('charging', [abandonedCall])
		const session = await interruptedSession({
			messages: [
				createUserMessage('charge once'),
				assistant,
				createUserMessage('the process restarted'),
				createToolMessage('too late to answer backwards', abandonedCall.id),
			],
		})
		const provider = new MockLLMProvider({ turns: [{ text: 'checked state first' }] })
		const events: SessionEvent[] = []

		const resumeParams = await baseParams(session)
		const outcome = await resumeSession({
			...resumeParams,
			provider,
			turnConfig: { ...resumeParams.turnConfig, maxIterations: 4 },
			listener: (event) => {
				events.push(event)
			},
		})

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		const sent = provider.requests[0]?.messages ?? []
		const ownerIndex = sent.findIndex(
			(message) =>
				message.role === 'assistant' &&
				message.toolCalls?.some((call) => call.id === abandonedCall.id),
		)
		expect(ownerIndex).toBeGreaterThanOrEqual(0)
		expect(sent[ownerIndex + 1]).toMatchObject({
			role: 'tool',
			toolCallId: abandonedCall.id,
			isError: true,
		})
		expect(sent[ownerIndex + 1]?.content).toContain('outcome is unknown')
		expect(sent[ownerIndex + 2]?.role).toBe('user')
		expect(sent).not.toContainEqual(
			expect.objectContaining({ content: 'too late to answer backwards' }),
		)
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'message_history_repaired',
				source: 'abandoned-checkpoint',
				orphanedToolResultsRemoved: 1,
				syntheticToolResultsInserted: 1,
			}),
		)
	})

	it('carries the spent budget forward instead of granting a fresh one', async () => {
		const session = await interruptedSession()

		const outcome = await resumeSession(await baseParams(session))

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		// A turn recalled at 120 tokens must not come back at zero — the
		// budget belongs to the turn, not to the process hosting it.
		expect(outcome.turn.tokenUsage.totalTokens).toBeGreaterThanOrEqual(120)
	})

	it('picks the newest checkpoint when the caller names none', async () => {
		const session = await interruptedSession({ release: false })
		const newest = await addCheckpoint(session)
		await session.log.release(session.lease)

		const outcome = await resumeSession(await baseParams(session))

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		expect(outcome.state.checkpointId).toBe(newest)
	})

	it('honours an explicitly named checkpoint', async () => {
		const session = await interruptedSession({ release: false })
		await addCheckpoint(session)
		await session.log.release(session.lease)

		const outcome = await resumeSession({
			...(await baseParams(session)),
			checkpointId: session.checkpointId,
		})

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		expect(outcome.state.checkpointId).toBe(session.checkpointId)
	})
})

describe('it refuses rather than guessing', () => {
	it('reports no checkpoint instead of silently starting fresh', async () => {
		const log = new InMemorySessionLog({ sessionId: SCOPE.sessionId })
		const outcome = await resumeSession(await baseParams({ log, store: checkpointStoreFor(log) }))

		// Starting a new turn here would be the worst outcome: a different
		// turn wearing a recycled id, with the original's budget reset.
		expect(outcome).toEqual({ resumed: false, reason: 'no-checkpoint' })
	})

	/** A park on the session's checkpoint, recorded the way a turn records one. */
	async function parkedSession(answered: boolean): Promise<CheckpointedSession> {
		const session = await interruptedSession({ release: false })
		const manager = new CheckpointManager(checkpointRecords(session), session.store, session.scope)
		const request = {
			type: 'tool_review',
			sessionId: SCOPE.sessionId,
			turnId: SCOPE.turnId,
			checkpointId: session.checkpointId,
			toolCalls: [{ id: 'call_1', name: 'write', input: {} }],
		} as unknown as HITLDecisionRequest
		await manager.park({ id: session.checkpointId }, request, { ttlMs: 60_000 })
		if (answered) await manager.unpark(session.checkpointId, { action: 'approve_tools' })
		await session.log.release(session.lease)
		return session
	}

	it('hands back the outstanding question instead of resuming past it', async () => {
		const session = await parkedSession(false)

		const outcome = await resumeSession(await baseParams(session))

		expect(outcome.resumed).toBe(false)
		if (outcome.resumed || outcome.reason !== 'awaiting-decision') {
			throw new Error(`expected awaiting-decision, got ${JSON.stringify(outcome)}`)
		}
		// The host needs the request itself to put in front of a person.
		expect(outcome.pending.request.type).toBe('tool_review')
		expect(outcome.state.turnId).toBe(SCOPE.turnId)
	})

	it('treats an already-answered park as an ordinary resume', async () => {
		const session = await parkedSession(true)

		const outcome = await resumeSession(await baseParams(session))

		// A resolved park is answered. Blocking on one that already has its
		// answer would strand the turn permanently.
		expect(outcome.resumed).toBe(true)
	})
})

describe('a resume carries the lease it was given', () => {
	/**
	 * The fix for "the fence never reached the runtime" was itself untested,
	 * and it is the most convincing kind of decorative test. The defect was
	 * that nothing handed the runtime the claim a worker took; so this drives
	 * the real entry point with a real log, and asserts the refusal, which
	 * only the log can produce: every record a stale holder appends is
	 * refused by its fence.
	 */
	async function iteratingParams(session: CheckpointedSession) {
		return {
			...(await baseParams(session)),
			provider: toolCallingProvider(),
			tools: registryWithEcho(),
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 3,
				maxResponseTokens: 256,
			},
		}
	}

	it('is refused when another worker has taken the session over', async () => {
		const session = await interruptedSession()
		// w1 takes the session and stalls. w2 reclaims it once the lease lapses.
		const stale = (await session.log.claim({ holder: 'w1', ttlMs: 1, now: 1_000 })) as SessionLease
		await session.log.claim({ holder: 'w2', ttlMs: 60_000, now: 5_000 })

		// w1 wakes up and resumes, still believing it holds the session. It
		// cannot know otherwise — a pause, a suspended container and a
		// partition all look from the inside like time not passing. The write
		// is the only place it can be told.
		const params = await iteratingParams(session)
		await expect(resumeSession({ ...params, lease: stale })).rejects.toThrow()
		// And it wrote nothing: w2's session is untouched by w1.
		expect(params.provider.requests).toHaveLength(0)
	})

	it('lets the current holder resume and finish', async () => {
		// The preservation half, and the one that keeps the test above from
		// passing on any failure at all. A refusal that fires for the rightful
		// holder too is not a fence, it is an outage.
		const session = await interruptedSession()
		const lease = (await session.log.claim({ holder: 'w1', ttlMs: 60_000 })) as SessionLease

		const outcome = await resumeSession({ ...(await iteratingParams(session)), lease })

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		expect(outcome.turn.status).not.toBe('failed')
	})

	it('claims the session itself when the host holds no lease', async () => {
		const session = await interruptedSession()

		const outcome = await resumeSession(await iteratingParams(session))

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		expect(outcome.turn.status).not.toBe('failed')
	})

	it('refuses to resume a session another worker holds', async () => {
		// One writer per session: without the holder's lease there is no
		// way in, and nothing is written.
		const session = await interruptedSession()
		await session.log.claim({ holder: 'somebody-else', ttlMs: 60_000 })
		const params = await iteratingParams(session)

		await expect(resumeSession(params)).rejects.toThrow()
		expect(params.provider.requests).toHaveLength(0)
	})
})

describe('a resumed run remembers the files this conversation wrote', () => {
	const written = 'alpha\nbeta\n'

	function wroteInHistory(path: string) {
		const call = {
			id: 'w1',
			type: 'function' as const,
			function: { name: 'write', arguments: JSON.stringify({ path, content: written }) },
		}
		return [
			createUserMessage('write note.txt'),
			createAssistantMessage('writing', [call]),
			createToolMessage(`Created ${path}`, call.id),
		]
	}

	function fileTools(): ToolRegistry {
		const tools = new ToolRegistry()
		tools.register(WriteFileTool)
		tools.register(EditTool)
		tools.register(ReadFileTool)
		return tools
	}

	it('carries the written body into the first resumed request instead of re-reading it', async () => {
		const session = await interruptedSession({ messages: wroteInHistory('note.txt') })
		const requests: Message[][] = []
		const base = await baseParams(session)
		const provider = new MockLLMProvider({
			onRequest: ({ messages }) => requests.push([...messages]),
			turns: [{ text: 'already know what is in it' }],
		})

		const outcome = await resumeSession({
			...base,
			provider,
			tools: fileTools(),
			turnConfig: { ...base.turnConfig, maxIterations: 4 },
		})

		expect(outcome.resumed).toBe(true)
		const first = requests[0]?.map((m) => String(m.content)).join('\n') ?? ''
		expect(first).toContain('Visible file evidence')
		expect(first).toContain('"bodyInCall":"w1"')
		// And it got there without going back to disk for it.
		expect(
			outcome.resumed &&
				outcome.turn.messages.some((m) =>
					m.role === 'assistant'
						? (m.toolCalls ?? []).some((c) => c.function.name === 'read')
						: false,
				),
		).toBe(false)
	})

	it('still refuses an edit against a file that moved while the session was closed', async () => {
		// The point of restoring a fingerprint rather than a permission: it is a
		// claim derived from history, and the mutation check still compares it
		// with the real file. A file somebody else changed in between is refused
		// exactly as it would be mid-session, and the refusal then withdraws the
		// projection's entry for that path.
		const workingDirectory = await mkWorkdir()
		const path = join(workingDirectory, 'note.txt')
		await writeFile(path, 'somebody else wrote this\n')
		const session = await interruptedSession({ messages: wroteInHistory(path) })
		const base = { ...(await baseParams(session)), workingDirectory }
		const requests: Message[][] = []
		const provider = new MockLLMProvider({
			onRequest: ({ messages }) => requests.push([...messages]),
			turns: [
				{ toolCalls: [{ name: 'edit', args: { path, old_string: 'alpha', new_string: 'gamma' } }] },
				{ text: 'it moved; re-reading' },
			],
		})

		const outcome = await resumeSession({
			...base,
			provider,
			tools: fileTools(),
			turnConfig: { ...base.turnConfig, maxIterations: 4 },
		})

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		const refusal = outcome.turn.messages.find(
			(m) => m.role === 'tool' && String(m.content).includes('changed on disk'),
		)
		expect(refusal).toBeDefined()
		// The first request offered the body; the one after the refusal does not.
		expect(requests[0]?.map((m) => String(m.content)).join('\n')).toContain('"bodyInCall":"w1"')
		expect(requests[1]?.map((m) => String(m.content)).join('\n')).not.toContain('"bodyInCall":"w1"')
		// Untouched: a refused edit writes nothing.
		expect(await readFile(path, 'utf-8')).toBe('somebody else wrote this\n')
	})

	it("carries the interrupted turn's own write instead of the body it replaced", async () => {
		// The turn a resume plan still OWNS is taken out of the history before
		// repair and put back long afterwards, so the seeding never saw it. A
		// write inside it that DID land — its receipt recovered from the run's
		// own transcript — had therefore changed the file while the ledger went
		// on holding the body from the turn before, and nothing took that claim
		// back until the next mutation happened to be refused for drift. The
		// seed folds the part of that turn which actually ran back in.
		const workingDirectory = await mkWorkdir()
		const path = join(workingDirectory, 'note.txt')
		const replaced = 'the turn that was interrupted wrote this\n'
		const interrupted = {
			id: 'w2',
			type: 'function' as const,
			function: { name: 'write', arguments: JSON.stringify({ path, content: replaced }) },
		}
		const session = await interruptedSession({
			messages: [...wroteInHistory(path), createAssistantMessage('and again', [interrupted])],
			release: false,
		})
		// The log says that write completed; the process died before its
		// result reached the history.
		for (const draft of [
			{
				type: 'tool_executing',
				turnId: SCOPE.turnId,
				toolUseId: 'w2',
				toolName: 'write',
				input: {},
			},
			{
				type: 'tool_completed',
				turnId: SCOPE.turnId,
				toolUseId: 'w2',
				toolName: 'write',
				result: `Created ${path}`,
				isError: false,
			},
		]) {
			await session.log.append(session.lease, draft as Parameters<SessionLog['append']>[1])
		}
		await session.log.release(session.lease)
		const base = { ...(await baseParams(session)), workingDirectory }
		const requests: Message[][] = []
		const provider = new MockLLMProvider({
			onRequest: ({ messages }) => requests.push([...messages]),
			turns: [{ text: 'the newer body, then' }],
		})

		const outcome = await resumeSession({
			...base,
			provider,
			tools: fileTools(),
			turnConfig: { ...base.turnConfig, maxIterations: 4 },
		})

		expect(outcome.resumed).toBe(true)
		const first = requests[0]?.map((m) => String(m.content)).join('\n') ?? ''
		// The body the interrupted turn put there, and not the one it replaced.
		expect(first).toContain('"bodyInCall":"w2"')
		expect(first).not.toContain('"bodyInCall":"w1"')
	})

	it('stays resumable when the seeding itself throws', async () => {
		// A rebuilt ledger is an optimisation over the empty one every resume
		// used to get. Letting it fail the resume would trade a conversation
		// that works for one that does not, so the failure is logged and the
		// run continues with no witnesses — the model reads what it needs.
		const session = await interruptedSession({ messages: wroteInHistory('note.txt') })
		const requests: Message[][] = []
		const base = await baseParams(session)
		const provider = new MockLLMProvider({
			onRequest: ({ messages }) => requests.push([...messages]),
			turns: [{ text: 'no witnesses, then' }],
		})

		const outcome = await resumeSession({
			...base,
			provider,
			tools: fileTools(),
			fileReadTracker: {
				...createFileReadTracker(),
				recordRead: () => {
					throw new Error('the ledger refused the entry')
				},
			},
			turnConfig: { ...base.turnConfig, maxIterations: 4 },
		})

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		expect(outcome.turn.status).not.toBe('failed')
		expect(requests[0]?.map((m) => String(m.content)).join('\n')).not.toContain(
			'Visible file evidence',
		)
	})

	it('offers nothing for a write whose receipt compaction had already cleared', async () => {
		const messages = wroteInHistory('note.txt')
		messages[2] = clearToolResult(messages[2] as ToolMessage, 'write').message
		const session = await interruptedSession({ messages })
		const requests: Message[][] = []
		const base = await baseParams(session)
		const provider = new MockLLMProvider({
			onRequest: ({ messages: sent }) => requests.push([...sent]),
			turns: [{ text: 'nothing to go on' }],
		})

		const outcome = await resumeSession({
			...base,
			provider,
			tools: fileTools(),
			turnConfig: { ...base.turnConfig, maxIterations: 4 },
		})

		expect(outcome.resumed).toBe(true)
		expect(requests[0]?.map((m) => String(m.content)).join('\n')).not.toContain(
			'Visible file evidence',
		)
	})
})
