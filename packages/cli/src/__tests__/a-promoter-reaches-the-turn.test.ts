/**
 * What the turn learned reaches the store the next turn reads from.
 *
 * `promoteMemory` is invoked once at settle with the compaction pass's
 * structured output, and **no shipped app supplied the hook** — so every
 * decision, discovery and stated requirement a turn extracted was serialized
 * into one system message and dropped when the turn ended. The promoter's own
 * unit tests prove what it writes; they prove nothing about whether anybody
 * asks it, and the hop from `createAgentSession` to `query()` is one line.
 *
 * So this ends at the `promoteMemory` `query()` was called with, and then
 * drives that function against the session's real memory store — because a
 * promoter wired to a DIFFERENT store than `search_memory` reads would pass
 * every reachability check and still lose the memory.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ToolRegistry } from '@namzu/sdk'
import type { SessionId, SessionMemoryCandidate, ToolContext, TurnId } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	sessionLegacyMemoryStore,
	sessionMemoryDir,
	sessionMemoryStore,
} from '../__fixtures__/session-memory.js'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'

const queryCalls: Record<string, unknown>[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			queryCalls.push(params)
			return (async function* () {})()
		},
	}
})

let cwd: string

beforeEach(() => {
	queryCalls.length = 0
	cwd = mkdtempSync(join(tmpdir(), 'namzu-promote-turn-'))
	mkdirSync(cwd, { recursive: true })
})

afterEach(() => {
	vi.restoreAllMocks()
	removeTempDir(cwd)
})

const prefs = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

function detectedAnthropic(): DetectedProvider[] {
	return [
		{
			entry: {
				id: 'anthropic',
				label: 'Anthropic',
				defaultModel: 'claude-sonnet-4-5',
				requiresApiKey: true,
				envVars: ['ANTHROPIC_API_KEY'],
			},
			source: 'env',
			apiKey: 'sk-ant-not-a-real-key',
			alternatives: [],
		} as unknown as DetectedProvider,
	]
}

function candidate(over: Partial<SessionMemoryCandidate> = {}): SessionMemoryCandidate {
	return {
		sessionId: '019a0000-0000-7000-8000-0000000000b1' as SessionId,
		turnId: 'a6ef4a3c-dd6b-4115-90d3-9fb61cdb2a81' as TurnId,
		task: 'wire the invoice job',
		decisions: [],
		discoveries: [],
		userRequirements: [],
		failures: [],
		environment: [],
		files: [],
		evicted: {},
		...over,
	}
}

async function drive(): Promise<(c: SessionMemoryCandidate) => void | Promise<void>> {
	const { createAgentSession } = await import('../tui/agent.js')
	const session = await createAgentSession(prefs, detectedAnthropic(), { cwd })
	for await (const _ of session.send([{ role: 'user', content: 'hi', timestamp: 0 }])) {
		// drain
	}
	expect(queryCalls.length, 'the turn must have reached query()').toBe(1)
	const promoteMemory = queryCalls[0]?.promoteMemory
	// Deleting the line that hands it over leaves every turn's extracted
	// knowledge on the floor at settle — silently, because a turn that
	// remembers nothing looks exactly like a turn that learned nothing.
	expect(typeof promoteMemory).toBe('function')
	return promoteMemory as (c: SessionMemoryCandidate) => void | Promise<void>
}

function toolContext(): ToolContext {
	return {
		sessionId: '019a0000-0000-7000-8000-0000000000b2' as SessionId,
		turnId: '225ccf73-c558-4774-8681-93fbe9048da9' as TurnId,
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

describe('the turn memory promoter', () => {
	it('is handed to every turn', async () => {
		await drive()
	})

	it('writes into the SAME store `search_memory` reads', async () => {
		const promote = await drive()

		await promote(candidate({ userRequirements: ['never email an invoice twice'] }))

		// Built the way the session builds it, at the path the memory tools
		// use. A promoter wired to a different directory would satisfy the
		// test above and lose the memory anyway — the model would search one
		// store while the runtime wrote to another.
		const store = sessionMemoryStore(cwd)
		const page = await store.list()
		expect(page.totalCount).toBe(1)
		expect(page.entries[0]?.type).toBe('project')
		expect(page.entries[0]?.title).toContain('invoice')
	})

	it('keeps what it writes out of the index, so the next turn’s system prompt is unchanged', async () => {
		const { createAgentSession } = await import('../tui/agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), { cwd })
		const turn = async () => {
			for await (const _ of session.send([{ role: 'user', content: 'hi', timestamp: 0 }])) {
				// drain
			}
			return queryCalls.at(-1) ?? {}
		}
		const first = await turn()
		const promote = first.promoteMemory as (c: SessionMemoryCandidate) => Promise<void>
		await promote(candidate({ userRequirements: ['never email an invoice twice'] }))
		const store = sessionMemoryStore(cwd)
		expect((await store.list()).totalCount).toBe(1)
		expect((await store.readIndex()).text).toBe('')
		// A turn's record changes nothing the prompt cache is keyed on.
		expect((await turn()).systemPrompt).toBe(first.systemPrompt)
	})

	it('finds persisted memory on the first search of a new CLI session', async () => {
		const writer = sessionLegacyMemoryStore(cwd)
		await writer.create({
			title: 'cold CLI memory',
			summary: 'must survive a new session',
			content: 'persisted before createAgentSession',
		})

		await drive()
		const tools = queryCalls[0]?.tools
		expect(tools).toBeInstanceOf(ToolRegistry)
		const result = await (tools as ToolRegistry).execute(
			'search_memory',
			{ query: 'cold CLI', limit: 10 },
			toolContext(),
		)

		expect(result.success).toBe(true)
		expect(result.output).toContain('cold CLI memory')
		expect(result.output).not.toBe('No memories found.')
		// It was found because the session moved the JSON store into Markdown
		// files, once: the old index is retired, not left to be read twice.
		const memoryDir = sessionMemoryDir(cwd)
		expect(existsSync(join(memoryDir, 'index.json'))).toBe(false)
		expect(existsSync(join(memoryDir, 'index.json.migrated'))).toBe(true)
		expect(readdirSync(memoryDir)).toContain('cold-cli-memory.md')
	})

	it('refuses to save over a structurally invalid durable index', async () => {
		const memoryDir = sessionMemoryDir(cwd)
		const indexPath = join(memoryDir, 'index.json')
		const poisoned = `${JSON.stringify(
			[
				{
					id: '35a72e04-ab18-430d-a1ca-72a21f549ed0',
					title: null,
					summary: 'valid JSON with an invalid memory shape',
					tags: [],
					status: 'active',
					createdAt: 0,
					updatedAt: 0,
				},
			],
			null,
			2,
		)}\n`
		mkdirSync(memoryDir, { recursive: true })
		writeFileSync(indexPath, poisoned)

		await drive()
		const tools = queryCalls[0]?.tools
		expect(tools).toBeInstanceOf(ToolRegistry)
		const result = await (tools as ToolRegistry).execute(
			'save_memory',
			{
				title: 'must not overwrite',
				summary: 'the CLI refuses poisoned durable state',
				content: 'this record must never be published',
			},
			toolContext(),
		)

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/memory|index/i)
		expect(readFileSync(indexPath, 'utf-8')).toBe(poisoned)
		// Refused by the Markdown store too: the unmigrated index holds records
		// it cannot see, so it writes nothing rather than answer without them.
		expect(readdirSync(memoryDir).filter((name) => name.endsWith('.md'))).toEqual([])
	})

	it('refuses to read indexed content whose durable shape is invalid', async () => {
		const writer = sessionLegacyMemoryStore(cwd)
		const { entry } = await writer.create({
			title: 'poisoned content',
			summary: 'the index entry itself is valid',
			content: 'must not be replaced by null',
		})
		const contentPath = join(sessionMemoryDir(cwd), 'content', `${entry.id}.json`)
		const poisoned = `${JSON.stringify({ id: entry.id, content: null, format: 'text' })}\n`
		writeFileSync(contentPath, poisoned)

		await drive()
		const tools = queryCalls[0]?.tools
		expect(tools).toBeInstanceOf(ToolRegistry)
		const result = await (tools as ToolRegistry).execute(
			'read_memory',
			{ id: entry.id },
			toolContext(),
		)

		expect(result.success).toBe(false)
		expect(result.output).not.toContain('must not be replaced')
		expect(result.error).toMatch(/memory|content|storage/i)
		expect(result.error).not.toContain('not found')
		expect(readFileSync(contentPath, 'utf-8')).toBe(poisoned)
	})

	it('refuses an indexed memory ID that escapes the content directory', async () => {
		const memoryDir = sessionMemoryDir(cwd)
		const contentDir = join(memoryDir, 'content')
		const escapedId = 'mem_/../../../outside-secret'
		const indexPath = join(memoryDir, 'index.json')
		const outsidePath = join(contentDir, `${escapedId}.json`)
		const indexBytes = `${JSON.stringify([
			{
				id: escapedId,
				title: 'crafted index',
				summary: 'must not grant filesystem authority',
				tags: [],
				status: 'active',
				createdAt: 1,
				updatedAt: 1,
			},
		])}\n`
		const outsideBytes = `${JSON.stringify({
			id: escapedId,
			content: 'outside secret bytes',
			format: 'text',
			schemaVersion: 1,
		})}\n`
		mkdirSync(contentDir, { recursive: true })
		writeFileSync(indexPath, indexBytes)
		writeFileSync(outsidePath, outsideBytes)

		await drive()
		const tools = queryCalls[0]?.tools
		expect(tools).toBeInstanceOf(ToolRegistry)
		const result = await (tools as ToolRegistry).execute(
			'read_memory',
			{ id: escapedId },
			toolContext(),
		)

		expect(result.success).toBe(false)
		expect(result.output).not.toContain('outside secret bytes')
		expect(result.error).not.toContain('outside secret bytes')
		expect(readFileSync(indexPath, 'utf-8')).toBe(indexBytes)
		expect(readFileSync(outsidePath, 'utf-8')).toBe(outsideBytes)
	})

	it('leaves the store empty for a turn that learned nothing', async () => {
		const promote = await drive()

		await promote(candidate({ files: ['src/a.ts'] }))

		const store = sessionMemoryStore(cwd)
		// Emptiness, not "the write succeeded". The model reads this store on
		// later turns, so a record per turn is context spent on runs that found
		// nothing.
		expect((await store.list()).totalCount).toBe(0)
	})
})
