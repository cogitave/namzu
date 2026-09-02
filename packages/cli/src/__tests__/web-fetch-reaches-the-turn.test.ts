/**
 * `web.fetch: true` reaches the turn as a tool, a provider and a rule — and
 * its absence reaches it as none of the three.
 *
 * Three hops, each droppable one function short of the provider:
 *
 *   config.web  → AgentSessionOptions.web
 *               → `web_fetch` in the parent registry
 *               → `web.fetch` provider handed to query()
 *               → the citation guidance registered as a contribution
 *
 * The negative half is the one that matters for the default: a session that
 * did not opt in must not carry the tool, because a tool the model can see
 * is a tool it will reach for, and "no web access" must be true rather than
 * merely refused at execution time.
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import type { Message, PromptContributionRegistry } from '@namzu/sdk'

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

beforeEach(() => {
	queryCalls.length = 0
	root = mkdtempSync(join(tmpdir(), 'namzu-web-'))
	mkdirSync(join(root, '.git'))
})

afterEach(() => {
	vi.restoreAllMocks()
	removeTempDir(root)
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

async function drive(web: { fetch?: boolean } | undefined) {
	const { createAgentSession } = await import('../tui/agent.js')
	const session = await createAgentSession(prefs, detectedAnthropic(), {
		cwd: root,
		...(web ? { web } : {}),
	})
	const messages: Message[] = [{ role: 'user', content: 'hi', timestamp: 0 }]
	for await (const _ of session.send(messages)) {
		// drain
	}
	expect(queryCalls.length, 'the turn must have reached query()').toBe(1)
	const call = queryCalls[0] as Record<string, unknown>
	const tools = call.tools as { listNames(): string[] }
	const contributions = call.promptContributions as PromptContributionRegistry
	return {
		session,
		toolNames: tools.listNames(),
		web: call.web as { fetch?: unknown } | undefined,
		hasGuidance: contributions.has('namzu.web.citations'),
	}
}

describe('web.fetch', () => {
	it('mounts the tool, hands query() a provider, and registers the citation guidance', async () => {
		const turn = await drive({ fetch: true })

		expect(turn.toolNames).toContain('web_fetch')
		expect(turn.session.toolNames()).toContain('web_fetch')
		expect(turn.web?.fetch, 'the tool without its provider reports itself unwired').toBeDefined()
		expect(turn.hasGuidance).toBe(true)
	})

	it('is off by default: no tool, no provider, no guidance', async () => {
		const turn = await drive(undefined)

		expect(turn.toolNames).not.toContain('web_fetch')
		expect(turn.toolNames).not.toContain('web_search')
		expect(turn.web).toBeUndefined()
		expect(turn.hasGuidance).toBe(false)
	})

	it('is off when the key is present but false', async () => {
		const turn = await drive({ fetch: false })

		expect(turn.toolNames).not.toContain('web_fetch')
		expect(turn.web).toBeUndefined()
	})

	it('never offers search, which this kernel has no backend for', async () => {
		const turn = await drive({ fetch: true })

		expect(turn.toolNames).not.toContain('web_search')
	})
})
