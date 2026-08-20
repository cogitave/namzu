import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DefaultPathBuilder,
	type Message,
	type RunEvent,
	type RunId,
	type SessionId,
	type UserMessage,
	asGoalId,
	asRunId,
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
	generateRunId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type CliSessions,
	appendMessages,
	forkConversation,
	forkConversationBeforeUser,
	openSessions,
	replaceConversation,
	startConversation,
} from './store.js'
import { conversationMarkdown, writeConversationExport } from './transcript-export.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

async function cwd(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-cli-transcript-export-'))
	dirs.push(dir)
	return dir
}

function recordedEvent(
	type: RunEvent['type'],
	runId: RunId,
	seq: number,
	fields: Record<string, unknown> = {},
): RunEvent {
	return { type, runId, seq, timestamp: seq, ...fields } as never
}

async function bindTurn(
	sessions: CliSessions,
	sessionId: SessionId,
	options: { readonly settle?: boolean } = { settle: true },
) {
	const runId = generateRunId()
	const user = createUserMessage('expanded contract body', [
		{ data: 'SECRET-IMAGE-BYTES', mediaType: 'image/png' },
		{
			type: 'document',
			data: 'SECRET-PDF-BYTES',
			mediaType: 'application/pdf',
			name: 'contract.pdf',
		},
	])
	const started = await sessions.turnEvidence?.recordTurnStarted({
		sessionId,
		runId,
		displayText: 'inspect @contract.pdf',
		user,
	})
	if (!started) throw new Error('fixture requires production evidence store')
	if (options.settle !== false) {
		await sessions.turnEvidence?.recordTurnSettled({
			sessionId,
			turnId: started.turnId,
			runId,
			outcome: 'completed',
			assistantText: 'I will **check**.Done.',
		})
	}
	return { runId, user, started }
}

async function publishCompleteRun(
	sessions: CliSessions,
	sessionId: SessionId,
	runId: RunId,
	user: Message,
	options: { readonly snapshotSeq?: number } = {},
): Promise<string> {
	const paths = new DefaultPathBuilder(sessions.root)
	const runDir = paths.runDir(sessions.projectId, sessionId, runId)
	await mkdir(runDir, { recursive: true })
	const toolUseId = 'toolu_export_1'
	const messages: Message[] = [
		user,
		createAssistantMessage('I will **check**.', [
			{
				id: toolUseId,
				type: 'function',
				function: { name: 'read_file', arguments: '{"path":"contract.md"}' },
			},
		]),
		createToolMessage('contract body', toolUseId),
		createAssistantMessage('Done.'),
	]
	const events = [
		recordedEvent('run_started', runId, 1),
		recordedEvent('message_completed', runId, 2, {
			iteration: 1,
			messageId: 'msg_export_1',
			stopReason: 'tool_use',
			content: 'I will **check**.',
		}),
		recordedEvent('tool_executing', runId, 3, {
			toolUseId,
			toolName: 'read_file',
			input: { path: 'contract.md' },
		}),
		recordedEvent('tool_completed', runId, 4, {
			toolUseId,
			toolName: 'read_file',
			result: 'contract body',
			isError: false,
		}),
		recordedEvent('message_completed', runId, 5, {
			iteration: 2,
			messageId: 'msg_export_2',
			stopReason: 'end_turn',
			content: 'Done.',
		}),
		recordedEvent('message_history_repaired', runId, 6, {
			source: 'fresh-history',
			duplicateToolResultsRemoved: 1,
			orphanedToolResultsRemoved: 2,
			syntheticToolResultsInserted: 3,
		}),
		recordedEvent('run_completed', runId, 7, { result: 'I will **check**.Done.' }),
	]
	await writeFile(
		join(runDir, 'transcript.jsonl'),
		`${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
		'utf-8',
	)
	await writeFile(
		join(runDir, 'messages.json'),
		`${JSON.stringify({
			format: 'namzu.run-message-snapshot.v1',
			throughEventSeq: options.snapshotSeq ?? 7,
			messages,
		})}\n`,
		'utf-8',
	)
	return runDir
}

async function publishSimpleTurn(
	sessions: CliSessions,
	sessionId: SessionId,
	userText: string,
	assistantText: string,
	options: { readonly user?: UserMessage; readonly persist?: boolean } = {},
) {
	const runId = generateRunId()
	const user = options.user ?? createUserMessage(userText)
	const assistant = createAssistantMessage(assistantText)
	const started = await sessions.turnEvidence?.recordTurnStarted({
		sessionId,
		runId,
		displayText: userText,
		user,
	})
	if (!started) throw new Error('fixture requires production evidence store')
	await sessions.turnEvidence?.recordTurnSettled({
		sessionId,
		turnId: started.turnId,
		runId,
		outcome: 'completed',
		assistantText,
	})
	if (options.persist !== false) await appendMessages(sessions, sessionId, [user, assistant])
	const runDir = new DefaultPathBuilder(sessions.root).runDir(sessions.projectId, sessionId, runId)
	await mkdir(runDir, { recursive: true })
	const events = [
		recordedEvent('run_started', runId, 1),
		recordedEvent('message_completed', runId, 2, {
			iteration: 1,
			messageId: `msg_${runId}`,
			stopReason: 'end_turn',
			content: assistantText,
		}),
		recordedEvent('run_completed', runId, 3, { result: assistantText }),
	]
	await writeFile(
		join(runDir, 'transcript.jsonl'),
		`${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
		'utf-8',
	)
	await writeFile(
		join(runDir, 'messages.json'),
		`${JSON.stringify({
			format: 'namzu.run-message-snapshot.v1',
			throughEventSeq: 3,
			messages: [user, assistant],
		})}\n`,
		'utf-8',
	)
	return { runId, user, assistant, started }
}

describe('verified conversation Markdown', () => {
	it('labels an automatic continuation as a goal round, not operator-authored input', async () => {
		const sessions = await openSessions(await cwd())
		const sessionId = await startConversation(sessions)
		const user = createUserMessage('internal model continuation prompt', undefined, {
			type: 'goal-round',
			goalId: asGoalId('goal_export_round'),
			objective: 'finish the release',
			goalRevision: 2,
			round: 1,
			maxGoalRounds: 4,
		})
		await publishSimpleTurn(sessions, sessionId, 'Goal round 1 / 4', 'progress', { user })

		const projected = await conversationMarkdown(sessions, sessionId)

		expect(projected.markdown).toContain('## Goal round 1 / 4')
		expect(projected.markdown).toContain('Objective: finish the release')
		expect(projected.markdown).toContain('internal model continuation prompt')
		expect(projected.markdown).not.toContain('## User')
	})

	it('projects raw assistant Markdown and tool input/result after the screen could be cleared', async () => {
		const root = await cwd()
		const sessions = await openSessions(root)
		const sessionId = await startConversation(sessions)
		const turn = await bindTurn(sessions, sessionId)
		await publishCompleteRun(sessions, sessionId, turn.runId, turn.user)

		const projected = await conversationMarkdown(sessions, sessionId)

		expect(projected.turns).toBe(1)
		expect(projected.markdown).toContain('inspect @contract.pdf')
		expect(projected.markdown).toContain('I will **check**.')
		expect(projected.markdown).toContain('`read_file`')
		expect(projected.markdown).toContain('{"path":"contract.md"}')
		expect(projected.markdown).toContain('contract body')
		expect(projected.markdown).not.toContain('SECRET-IMAGE-BYTES')
		expect(projected.markdown).not.toContain('SECRET-PDF-BYTES')
		expect(projected.markdown).toContain('binary data omitted')
		expect(projected.markdown).toContain('Tool history repaired (fresh-history)')
		expect(projected.markdown).toContain('3 interrupted call(s) closed with unknown outcome')
	})

	it('does not let a run belonging to a sibling session block this conversation', async () => {
		const sessions = await openSessions(await cwd())
		const sessionId = await startConversation(sessions)
		const sibling = await startConversation(sessions)
		const turn = await bindTurn(sessions, sessionId)
		await publishCompleteRun(sessions, sessionId, turn.runId, turn.user)
		await mkdir(
			new DefaultPathBuilder(sessions.root).runDir(
				sessions.projectId,
				sibling,
				asRunId('run_sibling'),
			),
			{ recursive: true },
		)

		await expect(conversationMarkdown(sessions, sessionId)).resolves.toMatchObject({ turns: 1 })
	})

	it('refuses an unbound run inside the same session', async () => {
		const sessions = await openSessions(await cwd())
		const sessionId = await startConversation(sessions)
		const turn = await bindTurn(sessions, sessionId)
		await publishCompleteRun(sessions, sessionId, turn.runId, turn.user)
		await mkdir(
			new DefaultPathBuilder(sessions.root).runDir(
				sessions.projectId,
				sessionId,
				asRunId('run_unbound'),
			),
			{ recursive: true },
		)

		await expect(conversationMarkdown(sessions, sessionId)).rejects.toMatchObject({
			reason: 'unbound-run',
		})
	})

	it('refuses a crash-point log with a start but no terminal event', async () => {
		const sessions = await openSessions(await cwd())
		const sessionId = await startConversation(sessions)
		const turn = await bindTurn(sessions, sessionId, { settle: false })
		const runDir = new DefaultPathBuilder(sessions.root).runDir(
			sessions.projectId,
			sessionId,
			turn.runId,
		)
		await mkdir(runDir, { recursive: true })
		await writeFile(
			join(runDir, 'transcript.jsonl'),
			`${JSON.stringify(recordedEvent('run_started', turn.runId, 1))}\n`,
			'utf-8',
		)

		await expect(conversationMarkdown(sessions, sessionId)).rejects.toMatchObject({
			reason: 'run-incomplete',
		})
	})

	it('refuses a survivor snapshot that was not published through the event head', async () => {
		const sessions = await openSessions(await cwd())
		const sessionId = await startConversation(sessions)
		const turn = await bindTurn(sessions, sessionId)
		await publishCompleteRun(sessions, sessionId, turn.runId, turn.user, { snapshotSeq: 5 })

		await expect(conversationMarkdown(sessions, sessionId)).rejects.toMatchObject({
			reason: 'run-snapshot-out-of-sync',
		})
	})

	it('refuses a malformed event line even when the tolerant SDK reader could skip it', async () => {
		const sessions = await openSessions(await cwd())
		const sessionId = await startConversation(sessions)
		const turn = await bindTurn(sessions, sessionId)
		const runDir = await publishCompleteRun(sessions, sessionId, turn.runId, turn.user)
		const transcript = await readFile(join(runDir, 'transcript.jsonl'), 'utf-8')
		const lines = transcript.trimEnd().split('\n')
		await writeFile(
			join(runDir, 'transcript.jsonl'),
			`${lines[0]}\nnot-json\n${lines.slice(1).join('\n')}\n`,
			'utf-8',
		)

		await expect(conversationMarkdown(sessions, sessionId)).rejects.toMatchObject({
			reason: 'run-record-corrupt',
		})
	})

	it('uses a settled host record for partial text that failed before message completion', async () => {
		const sessions = await openSessions(await cwd())
		const sessionId = await startConversation(sessions)
		const turn = await bindTurn(sessions, sessionId, { settle: false })
		await sessions.turnEvidence?.recordTurnSettled({
			sessionId,
			turnId: turn.started.turnId,
			runId: turn.runId,
			outcome: 'failed',
			assistantText: 'partial before failure',
		})
		const runDir = new DefaultPathBuilder(sessions.root).runDir(
			sessions.projectId,
			sessionId,
			turn.runId,
		)
		await mkdir(runDir, { recursive: true })
		const events = [
			recordedEvent('run_started', turn.runId, 1),
			recordedEvent('run_failed', turn.runId, 2, { error: 'stream broke' }),
		]
		await writeFile(
			join(runDir, 'transcript.jsonl'),
			`${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
			'utf-8',
		)
		await writeFile(
			join(runDir, 'messages.json'),
			`${JSON.stringify({
				format: 'namzu.run-message-snapshot.v1',
				throughEventSeq: 2,
				messages: [turn.user],
			})}\n`,
			'utf-8',
		)

		const projected = await conversationMarkdown(sessions, sessionId)
		expect(projected.markdown).toContain('partial before failure')
		expect(projected.markdown).toContain('Partial output captured')
		expect(projected.markdown).toContain('Run failed')
	})

	it('lets a durable host cancellation close a run whose adapter stopped before its terminal event', async () => {
		const sessions = await openSessions(await cwd())
		const sessionId = await startConversation(sessions)
		const turn = await bindTurn(sessions, sessionId, { settle: false })
		await sessions.turnEvidence?.recordTurnSettled({
			sessionId,
			turnId: turn.started.turnId,
			runId: turn.runId,
			outcome: 'cancelled',
			assistantText: 'partial before cancel',
		})
		const runDir = new DefaultPathBuilder(sessions.root).runDir(
			sessions.projectId,
			sessionId,
			turn.runId,
		)
		await mkdir(runDir, { recursive: true })
		await writeFile(
			join(runDir, 'transcript.jsonl'),
			`${JSON.stringify(recordedEvent('run_started', turn.runId, 1))}\n`,
			'utf-8',
		)
		await writeFile(
			join(runDir, 'messages.json'),
			`${JSON.stringify({
				format: 'namzu.run-message-snapshot.v1',
				throughEventSeq: 1,
				messages: [turn.user],
			})}\n`,
			'utf-8',
		)

		const projected = await conversationMarkdown(sessions, sessionId)
		expect(projected.markdown).toContain('partial before cancel')
	})

	it('exports a turn cancelled at the host admission boundary before an SDK run existed', async () => {
		const sessions = await openSessions(await cwd())
		const sessionId = await startConversation(sessions)
		const runId = generateRunId()
		const user = createUserMessage('cancel before provider start')
		const started = await sessions.turnEvidence?.recordTurnStarted({
			sessionId,
			runId,
			displayText: 'cancel before provider start',
			user,
		})
		if (!started) throw new Error('fixture requires production evidence store')
		await sessions.turnEvidence?.recordTurnSettled({
			sessionId,
			turnId: started.turnId,
			runId,
			outcome: 'cancelled',
			assistantText: '',
		})
		await appendMessages(sessions, sessionId, [user])

		const projected = await conversationMarkdown(sessions, sessionId)

		expect(projected.turns).toBe(1)
		expect(projected.markdown).toContain('cancel before provider start')
		expect(projected.markdown).toContain('cancelled before model execution began')
	})

	it('does not excuse a missing SDK run when the host claims any output or another outcome', async () => {
		for (const settlement of [
			{ outcome: 'failed' as const, assistantText: '' },
			{ outcome: 'cancelled' as const, assistantText: 'unverified partial' },
		]) {
			const sessions = await openSessions(await cwd())
			const sessionId = await startConversation(sessions)
			const runId = generateRunId()
			const user = createUserMessage('must have a run record')
			const started = await sessions.turnEvidence?.recordTurnStarted({
				sessionId,
				runId,
				displayText: 'must have a run record',
				user,
			})
			if (!started) throw new Error('fixture requires production evidence store')
			await sessions.turnEvidence?.recordTurnSettled({
				sessionId,
				turnId: started.turnId,
				runId,
				...settlement,
			})

			await expect(conversationMarkdown(sessions, sessionId)).rejects.toMatchObject({
				reason: 'turn-run-mismatch',
			})
		}
	})

	it('refuses a fork until its copied prefix has stable source-turn lineage', async () => {
		const sessions = await openSessions(await cwd())
		const source = await startConversation(sessions)
		await sessions.store.appendMessage(source, createUserMessage('source'), sessions.tenantId)
		const fork = await forkConversation(sessions, source)

		await expect(conversationMarkdown(sessions, fork.id)).rejects.toMatchObject({
			reason: 'fork-lineage-unavailable',
		})
	})

	it('exports the immutable source boundary of a resolved fork, not later source turns', async () => {
		const sessions = await openSessions(await cwd())
		const source = await startConversation(sessions)
		await publishSimpleTurn(sessions, source, 'source one', 'answer one')
		const fork = await forkConversation(sessions, source)

		await publishSimpleTurn(sessions, source, 'source later', 'answer later')
		const projected = await conversationMarkdown(sessions, fork.id)

		expect(projected.turns).toBe(1)
		expect(projected.markdown).toContain('source one')
		expect(projected.markdown).toContain('answer one')
		expect(projected.markdown).not.toContain('source later')
		expect(projected.markdown).not.toContain('answer later')
	})

	it('does not inherit evidence that advanced beyond the copied session history', async () => {
		const sessions = await openSessions(await cwd())
		const source = await startConversation(sessions)
		await publishSimpleTurn(sessions, source, 'durable source', 'durable answer')
		await publishSimpleTurn(sessions, source, 'evidence only', 'not copied', { persist: false })

		const fork = await forkConversation(sessions, source)
		const projected = await conversationMarkdown(sessions, fork.id)

		expect(projected.turns).toBe(1)
		expect(projected.markdown).toContain('durable answer')
		expect(projected.markdown).not.toContain('evidence only')
		expect(projected.markdown).not.toContain('not copied')
	})

	it('refuses resolved lineage when the copied session lost a settled assistant answer', async () => {
		const sessions = await openSessions(await cwd())
		const source = await startConversation(sessions)
		const partial = await publishSimpleTurn(sessions, source, 'partially saved', 'missing answer', {
			persist: false,
		})
		await appendMessages(sessions, source, [partial.user])

		const fork = await forkConversation(sessions, source)

		expect(await sessions.turnEvidence?.read(fork.id)).toMatchObject({
			kind: 'available',
			origin: { origin: { kind: 'fork-unresolved' } },
		})
		await expect(conversationMarkdown(sessions, fork.id)).rejects.toMatchObject({
			reason: 'fork-lineage-unavailable',
		})
	})

	it('flattens inherited and local turns when a fork is forked again', async () => {
		const sessions = await openSessions(await cwd())
		const source = await startConversation(sessions)
		await publishSimpleTurn(sessions, source, 'root turn', 'root answer')
		const firstFork = await forkConversation(sessions, source)
		await publishSimpleTurn(sessions, firstFork.id, 'branch turn', 'branch answer')
		const nested = await forkConversation(sessions, firstFork.id)

		const projected = await conversationMarkdown(sessions, nested.id)

		expect(projected.turns).toBe(2)
		expect(projected.markdown).toContain('root answer')
		expect(projected.markdown).toContain('branch answer')
		const origin = await sessions.turnEvidence?.read(nested.id)
		expect(origin).toMatchObject({
			kind: 'available',
			origin: {
				origin: { kind: 'fork', turns: [{ sessionId: source }, { sessionId: firstFork.id }] },
			},
		})
	})

	it('maps a compacted surviving prompt back to its unique raw turn boundary', async () => {
		const sessions = await openSessions(await cwd())
		const source = await startConversation(sessions)
		await publishSimpleTurn(sessions, source, 'older raw turn', 'older raw answer')
		const selected = await publishSimpleTurn(
			sessions,
			source,
			'surviving prompt',
			'answer to remove',
		)
		await replaceConversation(sessions, source, [
			{ role: 'system', content: 'opaque compacted context' } as Message,
			selected.user,
			selected.assistant,
		])

		const fork = await forkConversationBeforeUser(sessions, source, 0, selected.user)
		const projected = await conversationMarkdown(sessions, fork.id)

		expect(projected.turns).toBe(1)
		expect(projected.markdown).toContain('older raw turn')
		expect(projected.markdown).toContain('older raw answer')
		expect(projected.markdown).not.toContain('surviving prompt')
		expect(projected.markdown).not.toContain('answer to remove')
	})

	it('keeps an ambiguous compacted prompt unresolved instead of choosing a lookalike turn', async () => {
		const sessions = await openSessions(await cwd())
		const source = await startConversation(sessions)
		const repeated = createUserMessage('identical prompt')
		await publishSimpleTurn(sessions, source, 'identical prompt', 'first answer', {
			user: repeated,
		})
		const later = await publishSimpleTurn(sessions, source, 'identical prompt', 'first answer', {
			user: repeated,
		})
		await replaceConversation(sessions, source, [
			{ role: 'system', content: 'opaque compacted context' } as Message,
			repeated,
			later.assistant,
		])

		const fork = await forkConversationBeforeUser(sessions, source, 0, repeated)

		expect(await sessions.turnEvidence?.read(fork.id)).toMatchObject({
			kind: 'available',
			origin: { origin: { kind: 'fork-unresolved' } },
		})
		await expect(conversationMarkdown(sessions, fork.id)).rejects.toMatchObject({
			reason: 'fork-lineage-unavailable',
		})
	})

	it('refuses a run whose verified messages do not contain the exact bound user input', async () => {
		const sessions = await openSessions(await cwd())
		const sessionId = await startConversation(sessions)
		const turn = await bindTurn(sessions, sessionId)
		const runDir = await publishCompleteRun(
			sessions,
			sessionId,
			turn.runId,
			createUserMessage('other'),
		)
		expect(runDir).toContain(turn.runId)

		await expect(conversationMarkdown(sessions, sessionId)).rejects.toMatchObject({
			reason: 'turn-run-mismatch',
		})
	})

	it('writes atomically without replacing an existing export', async () => {
		const root = await cwd()
		const target = join(root, 'conversation.md')

		const first = await writeConversationExport('# one\n', target, root)
		expect(first.path).toBe(target)
		expect(await readFile(target, 'utf-8')).toBe('# one\n')
		await expect(writeConversationExport('# two\n', target, root)).rejects.toThrow(
			/nothing was overwritten/,
		)
		expect(await readFile(target, 'utf-8')).toBe('# one\n')
	})
})
