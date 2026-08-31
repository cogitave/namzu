/** A public SDK pause must survive the production AgentSession event bridge. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, Run, RunEvent } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: { readonly messages: readonly Message[] }) =>
			(async function* (): AsyncGenerator<RunEvent, Run> {
				yield {
					type: 'run_paused',
					runId: 'run_pause_reach' as never,
					checkpointId: 'cp_pause_reach' as never,
					reason: 'slow down',
					failure: {
						code: 'provider_error',
						message: 'slow down',
						retryable: true,
						details: { providerCode: 'rate_limit', retryAfterMs: 6_000 },
					},
					explanation: {
						id: 'provider.rate_limit',
						message: 'The provider is rate limiting this run.',
						hint: 'Wait before continuing.',
					},
				}
				return { messages: [...params.messages] } as unknown as Run
			})(),
	}
})

const preferences = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

const detected = [
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

const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

it('publishes checkpoint identity, classification and remedy from session.send', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-paused-run-reaches-session-'))
	roots.push(cwd)
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(preferences, detected, { cwd })
	const events = []
	try {
		for await (const event of session.send([{ role: 'user', content: 'go', timestamp: 1 }])) {
			events.push(event)
		}
	} finally {
		await session.close()
	}

	expect(events).toEqual([
		{
			kind: 'paused',
			checkpointId: 'cp_pause_reach',
			reason: 'slow down',
			failure: {
				code: 'provider_error',
				message: 'slow down',
				retryable: true,
				details: { providerCode: 'rate_limit', retryAfterMs: 6_000 },
			},
			explanation: {
				id: 'provider.rate_limit',
				message: 'The provider is rate limiting this run.',
				hint: 'Wait before continuing.',
			},
		},
	])
})
