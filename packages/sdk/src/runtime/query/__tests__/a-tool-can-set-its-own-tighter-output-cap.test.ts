import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../provider/mock.js'
import { DiskSessionLog, InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import { defineTool } from '../../../tools/defineTool.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	generateTurnId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

const directories: string[] = []
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true })
})

const CAP = 30_000
const SECRET = 'hunter2-password-value'

/** About 500 KB of lines, one of them carrying a value a screen must remove. */
const LARGE = Array.from({ length: 12_000 }, (_, i) =>
	i === 6_000 ? `row ${i} ${SECRET} end` : `row ${i} of the server answer`,
).join('\n')

function lookup(output: string) {
	return defineTool({
		name: 'lookup',
		description: 'Returns whatever text the test gives it',
		inputSchema: z.object({}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		maxOutputChars: CAP,
		async execute() {
			return { success: true, output }
		},
	})
}

async function run(output: string, readSlice?: { offset: number; limit: number }) {
	const directory = await mkdtemp(join(tmpdir(), 'namzu-tool-cap-'))
	directories.push(directory)
	const sessionId = generateSessionId()
	const sessionDir = join(directory, sessionId)
	const saved = join(
		sessionDir,
		'tool-results',
		`${createHash('sha256').update('c1').digest('hex')}.txt`,
	)
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'c1', name: 'lookup', args: {} }] },
			...(readSlice
				? [{ toolCalls: [{ id: 'c2', name: 'read', args: { path: saved, ...readSlice } }] }]
				: []),
			{ text: 'done' },
		],
	})
	const turn = await drainQuery({
		provider,
		toolsets: [testToolset(lookup(output), ReadFileTool)],
		toolResultGuardrails: [
			{
				name: 'password-screen',
				check: (ctx) =>
					ctx.output.includes(SECRET)
						? {
								action: 'rewrite' as const,
								output: ctx.output.split(SECRET).join('[REDACTED]'),
								reason: 'removed a password',
							}
						: { action: 'pass' as const },
			},
		],
		agentId: 'tool-cap',
		agentName: 'Tool cap',
		messages: [{ role: 'user' as const, content: 'go' }],
		workingDirectory: directory,
		projectId: generateProjectId(),
		sessionId,
		tenantId: generateTenantId(),
		topicId: generateTopicId(),
		turnId: generateTurnId(),
		sessionLog: new DiskSessionLog({
			sessionId,
			file: join(directory, `${sessionId}.jsonl`),
			sessionDir,
		}),
		turnConfig: { model: 'mock', tokenBudget: 1_000_000, maxIterations: 5, timeoutMs: 0 },
		toolTimeoutMs: 0,
		repeatCallAdvisory: false,
	})
	return { turn, saved, sessionDir }
}

const toolText = (turn: Awaited<ReturnType<typeof run>>['turn'], id: string): string => {
	const message = turn.messages.find((m) => m.role === 'tool' && m.toolCallId === id)
	return String(message?.content ?? '')
}

describe("a tool's own output cap", () => {
	it('keeps a 500 KB result to the tool cap and saves the full text in the session', async () => {
		expect(LARGE.length).toBeGreaterThan(300_000)
		const { turn, saved, sessionDir } = await run(LARGE)

		const shown = toolText(turn, 'c1')
		expect(shown.length).toBeLessThanOrEqual(CAP)
		expect(shown).toContain(saved)
		expect(saved.startsWith(join(sessionDir, 'tool-results'))).toBe(true)
		// The file is what the screens left, not the raw result.
		const file = await readFile(saved, 'utf8')
		expect(file).toBe(LARGE.split(SECRET).join('[REDACTED]'))
		expect(file).not.toContain(SECRET)
		expect(shown).not.toContain(SECRET)
	})

	it.skipIf(process.platform === 'win32')(
		'writes the file readable by its owner only',
		async () => {
			const { saved } = await run(LARGE)
			expect((await stat(saved)).mode & 0o777).toBe(0o600)
		},
	)

	it('lets the read tool open any slice of the saved text', async () => {
		// Line 6001 is far past anything the preview shows.
		const { turn } = await run(LARGE, { offset: 6_000, limit: 2 })
		expect(toolText(turn, 'c1')).not.toContain('row 6001 ')
		expect(toolText(turn, 'c2')).toContain('row 6001 of the server answer')
		expect(toolText(turn, 'c2')).toContain('[REDACTED]')
	})

	it('leaves a result under the cap exactly as it was', async () => {
		const small = 'a short answer\nsecond line'
		const { turn } = await run(small)
		expect(toolText(turn, 'c1')).toBe(small)
	})
})

describe("a tool's own output cap on the other result paths", () => {
	const MID = 'x'.repeat(35_000) // over the tool's cap, under the turn's default

	async function drive(tools: ReturnType<typeof lookup>[], calls: string[]) {
		const sessionId = generateSessionId()
		return drainQuery({
			provider: new MockLLMProvider({
				turns: [
					...calls.map((name, i) => ({ toolCalls: [{ id: `c${i}`, name, args: {} }] })),
					{ text: 'done' },
				],
			}),
			toolsets: [testToolset(...tools)],
			agentId: 'tool-cap',
			agentName: 'Tool cap',
			messages: [{ role: 'user' as const, content: 'go' }],
			workingDirectory: tmpdir(),
			projectId: generateProjectId(),
			sessionId,
			tenantId: generateTenantId(),
			topicId: generateTopicId(),
			turnId: generateTurnId(),
			sessionLog: new InMemorySessionLog({ sessionId }),
			turnConfig: { model: 'mock', tokenBudget: 1_000_000, maxIterations: 5, timeoutMs: 0 },
			toolTimeoutMs: 0,
			repeatCallAdvisory: false,
		})
	}

	it('applies to a call another tool makes', async () => {
		let nested = ''
		const caller = defineTool({
			name: 'caller',
			description: 'Calls the lookup tool',
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			async execute(_input, context) {
				nested = (await context.dispatchTool?.('lookup', {}))?.output ?? ''
				return { success: true, output: 'ok' }
			},
		})
		await drive([lookup(MID), caller as ReturnType<typeof lookup>], ['caller'])
		expect(nested.length).toBeGreaterThan(0)
		expect(nested.length).toBeLessThanOrEqual(CAP)
	})
})
