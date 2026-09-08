import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DefaultPathBuilder,
	MockLLMProvider,
	type RunEvent,
	type SessionId,
	ToolRegistry,
	createUserMessage,
	defineTool,
	generateRunId,
	mcpJsonSchemaToZod,
	query,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { searchConversation } from './conversation-search.js'
import {
	type CliSessions,
	appendMessages,
	loadConversation,
	openSessions,
	replaceConversation,
	startConversation,
} from './store.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-conversation-search-'))
	dirs.push(cwd)
	const sessions = await openSessions(cwd)
	const sessionId = await startConversation(sessions)
	return { cwd, sessions, sessionId }
}

async function transcript(sessions: CliSessions, sessionId: SessionId, text: string, tail = '') {
	const runId = generateRunId()
	const path = new DefaultPathBuilder(sessions.root).runDir(sessions.projectId, sessionId, runId)
	await mkdir(path, { recursive: true })
	await writeFile(
		join(path, 'transcript.jsonl'),
		`${[
			{ type: 'run_started', runId, seq: 1 },
			{ type: 'tool_completed', runId, seq: 2, result: text },
			{ type: 'run_completed', runId, seq: 3 },
		]
			.map((event) => JSON.stringify(event))
			.join('\n')}\n${tail}`,
	)
	return { runId, path }
}

describe('bounded original conversation evidence', () => {
	it('recovers tool evidence from a real SDK transcript containing a tool-only assistant turn', async () => {
		const { cwd, sessions, sessionId } = await fixture()
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'original_evidence',
				description: 'Return the immutable source identifier.',
				inputSchema: mcpJsonSchemaToZod({
					type: 'object',
					properties: {},
					additionalProperties: false,
				}),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => ({ success: true, output: 'REAL-SDK-IDENTIFIER-72af99' }),
			}),
		)
		const events: RunEvent[] = []
		for await (const event of query({
			provider: new MockLLMProvider({
				turns: [
					{
						toolCalls: [{ id: 'c1', name: 'original_evidence', args: {} }],
						finishReason: 'tool_calls',
					},
					{ text: 'Inspected the identifier.' },
				],
			}),
			tools,
			runConfig: { model: 'mock', timeoutMs: 10_000, tokenBudget: 100_000, maxIterations: 3 },
			agentId: 'evidence-test',
			agentName: 'Evidence test',
			messages: [createUserMessage('Inspect the source.')],
			workingDirectory: cwd,
			pathBuilder: new DefaultPathBuilder(sessions.root),
			sessionId,
			topicId: sessions.topicId,
			projectId: sessions.projectId,
			tenantId: sessions.tenantId,
			resumeHandler: async () => ({ action: 'continue' }),
		}))
			events.push(event)
		expect(events.some((event) => event.type === 'run_completed')).toBe(true)
		expect(
			events.some((event) => event.type === 'message_completed' && event.content === undefined),
		).toBe(true)
		await replaceConversation(sessions, sessionId, [
			createUserMessage('Compacted summary without identifier.'),
		])
		const restarted = await openSessions(cwd)
		const result = await searchConversation(restarted, sessionId, {
			query: 'REAL-SDK-IDENTIFIER-72af99',
		})
		expect(result.matches).toEqual([
			expect.objectContaining({ source: 'tool_completed', text: 'REAL-SDK-IDENTIFIER-72af99' }),
		])
		expect(result.incomplete).toBe(false)
		expect(result.unavailableRuns).toBe(0)
	})

	it('recovers exact earlier tool output after compacted projection and restart', async () => {
		const { cwd, sessions, sessionId } = await fixture()
		await appendMessages(sessions, sessionId, [createUserMessage('inspect the old result')])
		const original = await transcript(
			sessions,
			sessionId,
			'The immutable identifier is ORIGINAL-72af99.',
		)
		await replaceConversation(sessions, sessionId, [
			createUserMessage('Compacted: inspected a result.'),
		])
		const restarted = await openSessions(cwd)
		expect(JSON.stringify(await loadConversation(restarted, sessionId))).not.toContain(
			'ORIGINAL-72af99',
		)
		const result = await searchConversation(restarted, sessionId, {
			query: 'ORIGINAL-72af99',
		})
		expect(result.matches).toEqual([
			{
				runId: original.runId,
				seq: 2,
				source: 'tool_completed',
				text: 'The immutable identifier is ORIGINAL-72af99.',
			},
		])
		expect(result.incomplete).toBe(false)
	})

	it('does not read another session, project, tenant, or caller-selected path', async () => {
		const { sessions, sessionId } = await fixture()
		const other = await startConversation(sessions)
		const foreign = await transcript(sessions, other, 'PRIVATE-ID')
		expect(
			(
				await searchConversation(sessions, sessionId, {
					query: 'PRIVATE-ID',
					runId: foreign.runId,
				})
			).matches,
		).toEqual([])
		await expect(
			searchConversation(sessions, sessionId, {
				query: 'PRIVATE-ID',
				runId: '../secret',
			}),
		).rejects.toThrow()
		const second = await fixture()
		await expect(
			searchConversation(second.sessions, sessionId, { query: 'PRIVATE-ID' }),
		).rejects.toThrow()
		await expect(
			searchConversation(
				{ ...sessions, tenantId: 'foreign-tenant' as CliSessions['tenantId'] },
				sessionId,
				{ query: 'PRIVATE-ID' },
			),
		).rejects.toThrow()
	})

	it('rejects directory and file symlinks into another conversation', async () => {
		const { sessions, sessionId } = await fixture()
		const other = await startConversation(sessions)
		const foreign = await transcript(sessions, other, 'PRIVATE-ID')
		const root = join(
			new DefaultPathBuilder(sessions.root).sessionDir(sessions.projectId, sessionId),
			'runs',
		)
		await mkdir(root, { recursive: true })
		await symlink(foreign.path, join(root, foreign.runId), 'dir')
		const runId = generateRunId()
		await mkdir(join(root, runId))
		await symlink(join(foreign.path, 'transcript.jsonl'), join(root, runId, 'transcript.jsonl'))
		const result = await searchConversation(sessions, sessionId, {
			query: 'PRIVATE-ID',
		})
		expect(result.matches).toEqual([])
		expect(result.unavailableRuns).toBe(2)
	})

	it('does not claim absent original evidence when the retained tool output was truncated', async () => {
		const { sessions, sessionId } = await fixture()
		const { runId, path } = await transcript(sessions, sessionId, 'retained preview')
		await writeFile(
			join(path, 'transcript.jsonl'),
			`${[
				{ type: 'run_started', runId, seq: 1 },
				{
					type: 'tool_completed',
					runId,
					seq: 2,
					result: 'retained preview',
					outputTruncated: true,
					outputSpillPath: '/not-read-by-evidence-search',
				},
			]
				.map((event) => JSON.stringify(event))
				.join('\n')}\n`,
		)
		const result = await searchConversation(sessions, sessionId, {
			query: 'identifier omitted by the output budget',
		})
		expect(result.matches).toEqual([])
		expect(result.scannedRuns).toBe(1)
		expect(result.unavailableRuns).toBe(0)
		expect(result.incomplete).toBe(true)
	})

	it('bounds results and excerpts and reports oversized or corrupt evidence honestly', async () => {
		const { sessions, sessionId } = await fixture()
		await transcript(sessions, sessionId, `${'x'.repeat(10_000)}TARGET${'y'.repeat(10_000)}`)
		await transcript(sessions, sessionId, 'TARGET invalid tail', '{broken}\n')
		await transcript(sessions, sessionId, `TARGET${'x'.repeat(2 * 1024 * 1024)}`)
		const result = await searchConversation(sessions, sessionId, {
			query: 'TARGET',
			limit: 20,
		})
		expect(result.matches).toHaveLength(1)
		expect(result.matches[0]?.text.length).toBeLessThan(600)
		expect(result.unavailableRuns).toBe(2)
		expect(result.incomplete).toBe(true)
		expect(result.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
		await expect(
			searchConversation(sessions, sessionId, { query: 'TARGET', limit: 21 }),
		).rejects.toThrow()
	})
})
