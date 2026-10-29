/**
 * The skills a session offers travel as a reminder, through the real
 * AgentSession, and never inside the system prompt: a skill written while the
 * session runs must leave the cached prefix alone. The `skill` tool still
 * loads from the registry the turn is handed.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, ReminderSource } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

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
	cwd = mkdtempSync(join(tmpdir(), 'namzu-skill-reminder-'))
})
afterEach(() => {
	vi.restoreAllMocks()
	removeTempDir(cwd)
})

const DETECTED = [
	{
		entry: {
			id: 'anthropic',
			label: 'anthropic',
			defaultModel: 'fixture-model',
			requiresApiKey: true,
			envVars: ['ANTHROPIC_API_KEY'],
		},
		source: 'env',
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
] as unknown as DetectedProvider[]

function writeSkill(name: string, description: string): void {
	const dir = join(cwd, '.namzu', 'skills', name)
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, 'SKILL.md'),
		`---\nname: ${name}\ndescription: ${description}\n---\nInstructions for ${name}.`,
	)
}

async function remindersOf(call: Record<string, unknown> | undefined): Promise<string> {
	const source = call?.reminders as ReminderSource
	const messages: Message[] = [{ role: 'user', content: 'hi', timestamp: 0 }]
	const out = await source({
		sessionId: 'session' as never,
		turnId: 'turn' as never,
		iteration: 1,
		messages,
	})
	return (out ?? []).join('\n')
}

it('lists a project skill in the reminders and keeps the system prompt free of it', async () => {
	writeSkill('review-change', 'Review a change before it merges.')
	const { createAgentSession } = await import('../agent.js')
	const preferences = {
		version: 3,
		providers: [{ id: 'anthropic', model: 'claude-sonnet-5' }],
		subagents: { active: [] },
	} as Preferences
	const session = await createAgentSession(preferences, DETECTED, { cwd })
	try {
		for await (const _event of session.send([])) {
			// drain the mocked turn
		}
	} finally {
		await session.close()
	}
	const [call] = queryCalls
	expect(String(call?.systemPrompt)).not.toContain('review-change')
	expect(call?.skills).toBeUndefined()
	expect(call?.skillRegistry).toBeDefined()
	const told = await remindersOf(call)
	expect(told).toContain('kind="skill-listing"')
	expect(told).toContain('- review-change: Review a change before it merges.')
})

it('leaves the system prompt byte-for-byte the same when a skill is added between turns', async () => {
	writeSkill('review-change', 'Review a change before it merges.')
	const { createAgentSession } = await import('../agent.js')
	const preferences = {
		version: 3,
		providers: [{ id: 'anthropic', model: 'claude-sonnet-5' }],
		subagents: { active: [] },
	} as Preferences
	const session = await createAgentSession(preferences, DETECTED, { cwd })
	try {
		for await (const _event of session.send([])) {
			// first turn
		}
		writeSkill('ship-build', 'Ship a build to staging.')
		for await (const _event of session.send([])) {
			// second turn, one skill richer
		}
	} finally {
		await session.close()
	}
	const [first, second] = queryCalls
	expect(second?.systemPrompt).toBe(first?.systemPrompt)
	expect(await remindersOf(second)).toContain('- ship-build: Ship a build to staging.')
})
