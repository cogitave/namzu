import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DefaultPathBuilder, asRunId, createUserMessage, generateRunId } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { forkConversation, openSessions, startConversation } from './store.js'

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
		expect(await sessions.turnEvidence?.read(legacy.id)).toEqual({ kind: 'not-recorded' })
	})

	it('marks a fork origin as unresolved instead of claiming its copied prefix is proven', async () => {
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
