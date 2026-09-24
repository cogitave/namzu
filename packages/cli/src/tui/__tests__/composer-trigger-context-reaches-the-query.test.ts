/**
 * A composer trigger's words for the model travel as request-only context,
 * through the real AgentSession: the `context` placement, rendered at every
 * iteration, and never the system prompt. The system prompt — the cached
 * prefix — is byte-for-byte the same with a trigger and without one, and the
 * session's hypermode flag is not set by a one-turn request.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PromptContributionRegistry } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { triggerContextTexts } from '../triggers/context-text.js'

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
	cwd = mkdtempSync(join(tmpdir(), 'namzu-trigger-context-'))
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

function contextOf(call: Record<string, unknown> | undefined): readonly string[] {
	const registry = call?.promptContributions as PromptContributionRegistry | undefined
	return registry?.render('context', { iteration: 2 } as never) ?? []
}

it('sends the trigger text as request-only context and leaves the system prompt alone', async () => {
	const { createAgentSession } = await import('../agent.js')
	const preferences = {
		version: 3,
		providers: [{ id: 'anthropic', model: 'claude-sonnet-5' }],
		subagents: { active: [] },
	} as Preferences
	const session = await createAgentSession(preferences, DETECTED, { cwd })
	const texts = triggerContextTexts(['hypermode', 'save-skill'])
	try {
		for await (const _event of session.send([])) {
			// a turn with no trigger
		}
		for await (const _event of session.send([], { hostContext: () => texts, effort: 'high' })) {
			// the same turn with hypermode and save-as-skill armed
		}
	} finally {
		await session.close()
	}
	const [without, withTriggers] = queryCalls
	expect(typeof without?.systemPrompt).toBe('string')
	expect(withTriggers?.systemPrompt).toBe(without?.systemPrompt)
	expect(String(withTriggers?.systemPrompt)).not.toContain('THIS turn only')
	expect(String(withTriggers?.systemPrompt)).not.toContain('This session has hypermode on')
	expect(contextOf(without).join('\n')).not.toContain('THIS turn only')
	const context = contextOf(withTriggers).join('\n')
	for (const text of texts) expect(context).toContain(text)
	expect(
		(withTriggers?.promptContributions as PromptContributionRegistry)
			.list()
			.find((contribution) => contribution.id === 'namzu.cli.composer-triggers')?.placement,
	).toBe('context')
})
