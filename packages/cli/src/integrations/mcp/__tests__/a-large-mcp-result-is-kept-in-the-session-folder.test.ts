import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	MockLLMProvider,
	ReadFileTool,
	type Toolset,
	defineTool,
	drainQuery,
	generateTurnId,
	mcpJsonSchemaToZod,
	toolset,
	wrapUntrusted,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import {
	closeSessions,
	conversationDir,
	discardConversation,
	openConversationLog,
	openSessions,
	startConversation,
} from '../../sessions/store.js'
import { MCP_OUTPUT_CHARS, boundedMcpResult, boundedMcpToolset } from '../output.js'

const directories: string[] = []
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true })
})

/** What the SDK connector hands over: the server's text, already framed. */
const framed = (text: string) =>
	wrapUntrusted({ kind: 'connector-tool-result', provenance: 'Server output.' }, text)

const BODY = Array.from({ length: 12_000 }, (_, i) => `row ${i} of the server answer`).join('\n')

async function runThroughExecutor() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-mcp-spill-'))
	directories.push(root)
	const cwd = join(root, 'project')
	await mkdir(cwd)
	const sessions = await openSessions(cwd, { stateRoot: join(root, 'state') })
	const sessionId = await startConversation(sessions)
	const server = defineTool({
		name: 'mcp__docs__read',
		description: 'Reads a document from a server',
		inputSchema: mcpJsonSchemaToZod({ type: 'object', properties: {} }),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute() {
			return { success: true, output: framed(BODY) }
		},
	})
	const mounted: Toolset = boundedMcpToolset(toolset('mcp:docs', [server]))
	const turn = await drainQuery({
		provider: new MockLLMProvider({
			turns: [{ toolCalls: [{ id: 'c1', name: 'mcp__docs__read', args: {} }] }, { text: 'done' }],
		}),
		toolsets: [mounted, toolset('builtin', [ReadFileTool])],
		agentId: 'mcp-spill',
		agentName: 'Mcp spill',
		messages: [{ role: 'user' as const, content: 'go' }],
		workingDirectory: cwd,
		projectId: sessions.projectId,
		sessionId,
		tenantId: sessions.tenantId,
		topicId: sessions.topicId,
		turnId: generateTurnId(),
		sessionLog: openConversationLog(sessions, sessionId),
		turnConfig: { model: 'mock', tokenBudget: 1_000_000, maxIterations: 5, timeoutMs: 0 },
		toolTimeoutMs: 0,
		repeatCallAdvisory: false,
	})
	return { sessions, sessionId, turn }
}

describe('a large MCP result kept in the session folder', () => {
	it('saves the framed text in the conversation folder and removes it with the conversation', async () => {
		const { sessions, sessionId, turn } = await runThroughExecutor()
		try {
			const shown = String(turn.messages.find((m) => m.role === 'tool')?.content ?? '')
			expect(shown.length).toBeLessThanOrEqual(MCP_OUTPUT_CHARS)
			const folder = join(conversationDir(sessions, sessionId), 'tool-results')
			const found = shown.match(/(\/\S+\.txt)/)?.[1]
			expect(found?.startsWith(folder)).toBe(true)
			const file = await readFile(found as string, 'utf8')
			expect(file).toContain(BODY)
			// Exactly one frame, opened and closed, around the whole text.
			expect(file.match(/<namzu-untrusted-[0-9a-f]+ /g)).toHaveLength(1)
			expect(file).toMatch(/<\/namzu-untrusted-[0-9a-f]+>\s*$/)
			expect(file.startsWith('<namzu-untrusted-')).toBe(true)

			await discardConversation(sessions, sessionId)
			expect(existsSync(found as string)).toBe(false)
			expect(existsSync(folder)).toBe(false)
		} finally {
			closeSessions(sessions)
		}
	})
})

describe('what decides a result is too large', () => {
	it('leaves text under the cap alone however long it looks once escaped', () => {
		const text = framed('y'.repeat(10_000))
		const result = { success: true, output: text, data: { n: 1 } }
		expect(boundedMcpResult(result)).toBe(result)
	})

	it('does not frame a text the connector already framed, and says what was omitted', () => {
		const text = framed('z'.repeat(40_000))
		const out = boundedMcpResult({ success: true, output: text, data: { n: 1 } })
		expect(out.output.endsWith(text)).toBe(true)
		expect(out.output.match(/<namzu-untrusted-[0-9a-f]+ /g)).toHaveLength(1)
		expect(out.output).toContain('omitted')
		expect(out).not.toHaveProperty('data')
	})

	it('frames an unframed oversized text once, with the omission in the provenance', () => {
		const out = boundedMcpResult({ success: true, output: 'q'.repeat(40_000), data: { n: 1 } })
		expect(out.output.match(/<namzu-untrusted-[0-9a-f]+ /g)).toHaveLength(1)
		expect(out.output).toContain('Structured data and rich content')
	})
})
