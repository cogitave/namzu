/** The CLI session must carry live input to the SDK boundary that already owns it. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

let cwd: string

beforeEach(() => {
	queryCalls.length = 0
	cwd = mkdtempSync(join(tmpdir(), 'namzu-live-input-'))
})

afterEach(() => removeTempDir(cwd))

describe('the live-input session hop', () => {
	it('hands the exact callback and rich message to query()', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(preferences, detected, { cwd })
		const image = { data: 'AAAA', mediaType: 'image/png' as const }
		const steered: Message = {
			role: 'user',
			content: 'look at this too',
			attachments: [image],
			timestamp: 2,
		}
		const inboundMessages = vi.fn(() => [steered])
		try {
			for await (const _event of session.send([{ role: 'user', content: 'start', timestamp: 1 }], {
				inboundMessages,
			})) {
				// drain the real AgentSession boundary
			}

			expect(queryCalls).toHaveLength(1)
			expect(queryCalls[0]?.inboundMessages).toBe(inboundMessages)
			expect((queryCalls[0]?.inboundMessages as () => Message[])()).toEqual([steered])
			expect(inboundMessages).toHaveBeenCalledTimes(1)
		} finally {
			await session.close()
		}
	})
})
