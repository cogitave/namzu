/**
 * The agent is told what day it is and which branch it is on, in the request
 * that is actually sent.
 *
 * A composer test proves the sentence is well formed and nothing about whether
 * anyone says it. The failure this invites is the block existing, being
 * correct, and never being joined into the prompt — which is silent: the model
 * keeps answering from its training cut-off, confidently, and every date it
 * writes into a changelog or a frontmatter field looks like an ordinary answer.
 *
 * So this starts at a REAL repository on disk and ends at the `systemPrompt`
 * `query()` was called with, and it drives the sub-agent path as well, because
 * a delegated task dating a file from the wrong year is the same defect one
 * hop further out.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type AgentDefinition, AgentRegistry } from '@namzu/sdk'

import { localIsoDate } from '../context/environment.js'
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

let root: string
let repo: string

beforeEach(() => {
	queryCalls.length = 0
	root = mkdtempSync(join(tmpdir(), 'namzu-env-turn-'))
	repo = join(root, 'repo')
	mkdirSync(repo, { recursive: true })
	execFileSync('git', ['init', '--quiet'], { cwd: repo })
	execFileSync('git', ['checkout', '-q', '-b', 'feature/parser'], { cwd: repo })
})

afterEach(() => {
	vi.restoreAllMocks()
	rmSync(root, { recursive: true, force: true })
})

const prefs = {
	version: 2,
	provider: 'anthropic',
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

async function openSessionIn(cwd: string) {
	const { createAgentSession } = await import('../tui/agent.js')
	return createAgentSession(prefs, detectedAnthropic(), { cwd })
}

async function drive(cwd: string): Promise<string> {
	const session = await openSessionIn(cwd)
	for await (const _ of session.send([{ role: 'user', content: 'hi', timestamp: 0 }])) {
		// drain
	}
	expect(queryCalls.length, 'the turn must have reached query()').toBe(1)
	return String(queryCalls[0]?.systemPrompt ?? '')
}

describe('where and when the agent is', () => {
	it("is in the system prompt of the turn, with today's date", async () => {
		const systemPrompt = await drive(repo)

		expect(systemPrompt).toContain(localIsoDate(new Date()))
	})

	it('names the branch that is actually checked out', async () => {
		const systemPrompt = await drive(repo)

		expect(systemPrompt).toContain('feature/parser')
	})

	it('follows the branch when it changes mid-session, instead of repeating the old one', async () => {
		// The reason this is read per turn. An agent that checks out a branch
		// itself — an ordinary thing to be asked to do — would otherwise spend
		// the rest of the session asserting the branch it started on, which is
		// worse than never having been told.
		const session = await openSessionIn(repo)
		for await (const _ of session.send([{ role: 'user', content: 'hi', timestamp: 0 }])) {
			// drain
		}
		execFileSync('git', ['checkout', '-q', '-b', 'feature/lexer'], { cwd: repo })
		for await (const _ of session.send([{ role: 'user', content: 'again', timestamp: 0 }])) {
			// drain
		}

		expect(String(queryCalls[0]?.systemPrompt)).toContain('feature/parser')
		expect(String(queryCalls[1]?.systemPrompt)).toContain('feature/lexer')
	})

	it('says a plain directory is not a repository', async () => {
		const plain = join(root, 'plain')
		mkdirSync(plain)

		const systemPrompt = await drive(plain)

		expect(systemPrompt).toContain('not a git repository')
	})

	it('reaches a sub-agent too', async () => {
		const registered: AgentDefinition[] = []
		vi.spyOn(AgentRegistry.prototype, 'register').mockImplementation((def) => {
			for (const d of Array.isArray(def) ? def : [def]) registered.push(d)
		})

		await openSessionIn(repo)

		const general = registered.find((d) => d.info.id === 'general-purpose')
		if (!general?.configBuilder) {
			throw new Error('the sub-agent runtime did not stand up — this test proves nothing')
		}
		const config = (await general.configBuilder({})) as { systemPrompt?: string }
		expect(config.systemPrompt).toContain('feature/parser')
		expect(config.systemPrompt).toContain(localIsoDate(new Date()))
	})
})
