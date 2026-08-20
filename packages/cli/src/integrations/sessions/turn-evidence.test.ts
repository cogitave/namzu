import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DefaultPathBuilder,
	asRunId,
	createAssistantMessage,
	createProjectInstructionMessage,
	createUserMessage,
	generateRunId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { appendMessages, forkConversation, openSessions, startConversation } from './store.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

async function cwd(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-cli-turn-evidence-'))
	dirs.push(dir)
	return dir
}

describe('CLI turn evidence', () => {
	it('round-trips the exact displayed and provider messages before recording settlement', async () => {
		const sessions = await openSessions(await cwd())
		const sessionId = await startConversation(sessions)
		const runId = generateRunId()
		const user = createUserMessage('expanded file contents', [
			{ data: 'image-bytes', mediaType: 'image/png' },
			{
				type: 'document',
				data: 'pdf-bytes',
				mediaType: 'application/pdf',
				name: 'contract.pdf',
				citations: true,
			},
			{
				type: 'stored',
				ref: 'attachment_1',
				kind: 'document',
				mediaType: 'text/plain',
				name: 'notes.txt',
			},
		])

		const started = await sessions.turnEvidence?.recordTurnStarted({
			sessionId,
			runId,
			displayText: 'inspect @contract.pdf',
			user,
		})
		expect(started).toBeDefined()
		await sessions.turnEvidence?.recordTurnSettled({
			sessionId,
			turnId: started?.turnId ?? '',
			runId,
			outcome: 'completed',
			assistantText: '**done**',
		})

		const readBack = await sessions.turnEvidence?.read(sessionId)
		expect(readBack).toEqual({
			kind: 'available',
			origin: expect.objectContaining({
				type: 'conversation_started',
				origin: { kind: 'new' },
			}),
			turns: [
				{
					started,
					settled: expect.objectContaining({
						turnId: started?.turnId,
						runId,
						assistantText: '**done**',
					}),
				},
			],
		})
	})

	it('distinguishes a missing ledger from an empty, valid conversation', async () => {
		const sessions = await openSessions(await cwd())
		const valid = await startConversation(sessions)
		const legacy = await sessions.store.createSession(
			{
				topicId: sessions.topicId,
				projectId: sessions.projectId,
				currentActor: null,
			},
			sessions.tenantId,
		)

		expect(await sessions.turnEvidence?.read(valid)).toMatchObject({
			kind: 'available',
			turns: [],
		})
		expect(await sessions.turnEvidence?.read(legacy.id)).toEqual({
			kind: 'not-recorded',
		})
	})

	it('round-trips structurally tagged project-policy provenance', async () => {
		const sessions = await openSessions(await cwd())
		const sessionId = await startConversation(sessions)
		const runId = generateRunId()
		const policy = createProjectInstructionMessage('standing policy', [
			'AGENTS.md',
			'packages/a/AGENTS.md',
		])
		const started = await sessions.turnEvidence?.recordTurnStarted({
			sessionId,
			runId,
			displayText: 'Project instructions',
			user: policy,
		})

		expect(await sessions.turnEvidence?.read(sessionId)).toMatchObject({
			kind: 'available',
			turns: [{ started: { user: policy } }],
		})
		expect(started?.user).toEqual(policy)
	})

	it('keeps a legacy fork unresolved instead of claiming its copied prefix is proven', async () => {
		const sessions = await openSessions(await cwd())
		const source = await startConversation(sessions)
		await sessions.store.appendMessage(
			source,
			createUserMessage('source prompt'),
			sessions.tenantId,
		)

		const fork = await forkConversation(sessions, source)

		expect(await sessions.turnEvidence?.read(fork.id)).toMatchObject({
			kind: 'available',
			origin: {
				origin: {
					kind: 'fork-unresolved',
					sourceSessionId: source,
					copiedMessages: 1,
				},
			},
		})
	})

	it('flattens a proven source turn into an immutable fork lineage', async () => {
		const sessions = await openSessions(await cwd())
		const source = await startConversation(sessions)
		const user = createUserMessage('source prompt')
		const assistant = createAssistantMessage('source answer')
		const runId = generateRunId()
		const started = await sessions.turnEvidence?.recordTurnStarted({
			sessionId: source,
			runId,
			displayText: 'source prompt',
			user,
		})
		if (!started) throw new Error('fixture requires turn evidence')
		await sessions.turnEvidence?.recordTurnSettled({
			sessionId: source,
			turnId: started.turnId,
			runId,
			outcome: 'completed',
			assistantText: 'source answer',
		})
		await appendMessages(sessions, source, [user, assistant])

		const fork = await forkConversation(sessions, source)
		const record = await sessions.turnEvidence?.read(fork.id)
		const lineage = await sessions.turnEvidence?.resolveLineage(fork.id)

		expect(record).toMatchObject({
			kind: 'available',
			origin: {
				origin: {
					kind: 'fork',
					sourceSessionId: source,
					copiedMessages: 2,
					turns: [{ sessionId: source, turnId: started.turnId }],
				},
			},
		})
		expect(lineage).toMatchObject({
			kind: 'available',
			localTurns: [],
			turns: [
				{
					reference: { sessionId: source, turnId: started.turnId },
					evidence: { started },
				},
			],
		})
	})

	it('refuses a resolved prefix that does not belong to its declared source', async () => {
		const sessions = await openSessions(await cwd())
		const declaredSource = await startConversation(sessions)
		const otherSource = await startConversation(sessions)
		const runId = generateRunId()
		const otherTurn = await sessions.turnEvidence?.recordTurnStarted({
			sessionId: otherSource,
			runId,
			displayText: 'other',
			user: createUserMessage('other'),
		})
		if (!otherTurn) throw new Error('fixture requires turn evidence')
		const child = await sessions.store.createSession(
			{
				topicId: sessions.topicId,
				projectId: sessions.projectId,
				currentActor: null,
			},
			sessions.tenantId,
		)
		await sessions.turnEvidence?.recordOrigin(child.id, {
			kind: 'fork',
			sourceSessionId: declaredSource,
			copiedMessages: 0,
			turns: [{ sessionId: otherSource, turnId: otherTurn.turnId }],
		})

		await expect(sessions.turnEvidence?.resolveLineage(child.id)).rejects.toThrow(
			/not a prefix of source/,
		)
	})

	it('refuses a cycle even when every individual fork origin parses', async () => {
		const sessions = await openSessions(await cwd())
		const first = await sessions.store.createSession(
			{
				topicId: sessions.topicId,
				projectId: sessions.projectId,
				currentActor: null,
			},
			sessions.tenantId,
		)
		const second = await sessions.store.createSession(
			{
				topicId: sessions.topicId,
				projectId: sessions.projectId,
				currentActor: null,
			},
			sessions.tenantId,
		)
		await sessions.turnEvidence?.recordOrigin(first.id, {
			kind: 'fork',
			sourceSessionId: second.id,
			copiedMessages: 0,
			turns: [],
		})
		await sessions.turnEvidence?.recordOrigin(second.id, {
			kind: 'fork',
			sourceSessionId: first.id,
			copiedMessages: 0,
			turns: [],
		})

		await expect(sessions.turnEvidence?.resolveLineage(first.id)).rejects.toThrow(/cycle/)
	})

	it('refuses torn and duplicate bindings rather than skipping them', async () => {
		const root = await cwd()
		const sessions = await openSessions(root)
		const sessionId = await startConversation(sessions)
		const path = join(
			new DefaultPathBuilder(join(root, '.namzu')).sessionDir(sessions.projectId, sessionId),
			'turns.jsonl',
		)
		await appendFile(path, '{"format":"namzu.cli-turn-evidence.v1"', 'utf-8')

		await expect(sessions.turnEvidence?.read(sessionId)).rejects.toThrow(/torn final record/)

		const raw = await readFile(path, 'utf-8')
		await writeFile(path, `${raw.slice(0, raw.indexOf('\n') + 1)}`, 'utf-8')
		const runId = asRunId('run_duplicate')
		const started = await sessions.turnEvidence?.recordTurnStarted({
			sessionId,
			runId,
			displayText: 'same',
			user: createUserMessage('same'),
		})
		const line = `${JSON.stringify(started)}\n`
		await appendFile(path, line, 'utf-8')

		await expect(sessions.turnEvidence?.read(sessionId)).rejects.toThrow(/reuses turn|run/)
	})
})
