/** A real DeepSeek session explains PDF degradation before its local refusal. */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { createAgentSession } from '../agent.js'

const roots: string[] = []

afterEach(() => {
	vi.unstubAllGlobals()
	for (const root of roots.splice(0)) removeTempDir(root)
})

it('surfaces the document mismatch before DeepSeek refuses the attachment locally', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-deepseek-document-warning-'))
	roots.push(cwd)
	const network = vi.fn(() => {
		throw new Error('network must not be reached for a locally unsupported attachment')
	})
	vi.stubGlobal('fetch', network)
	const preferences: Preferences = {
		version: 3,
		providers: [{ id: 'deepseek' }],
		subagents: { active: [] },
	}
	const detected = [
		{
			entry: PROVIDER_REGISTRY.deepseek,
			source: { kind: 'env', envName: 'DEEPSEEK_API_KEY' },
			apiKey: 'not-a-real-key',
			alternatives: [],
		} as DetectedProvider,
	]
	const session = await createAgentSession(preferences, detected, { cwd })
	const events = []

	try {
		for await (const event of session.send([
			createUserMessage('Read this lease', [
				{
					type: 'document',
					data: 'JVBERi0xLjQK',
					mediaType: 'application/pdf',
					name: 'lease.pdf',
				},
			]),
		])) {
			events.push(event)
		}
	} finally {
		await session.close()
	}

	const warningIndex = events.findIndex(
		(event) => event.kind === 'capability-warning' && event.capability === 'documents',
	)
	const errorIndex = events.findIndex((event) => event.kind === 'error')
	expect(warningIndex).toBeGreaterThanOrEqual(0)
	expect(errorIndex).toBeGreaterThan(warningIndex)
	expect(events[warningIndex]).toMatchObject({
		kind: 'capability-warning',
		capability: 'documents',
	})
	expect(network).not.toHaveBeenCalled()
})
