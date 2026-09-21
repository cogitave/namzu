/**
 * A session writes its generated state to the application home, never into
 * the directory it works in.
 *
 * `createAgentSession` defaulted its state root to `<cwd>/.namzu` whenever no
 * host passed one. Every production entry point passes one, so the default
 * only ever fired for embedders and tests — which is how runtime trees kept
 * appearing inside this repository (`packages/cli/.namzu/...`), and how a
 * session started from the home directory made the project root and the
 * application home the same directory.
 *
 * The session also used to mint a Project per launch when it was given no
 * scope, so a second session in the same directory could not see the memory
 * the first had saved. The Project is now the directory's.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { MockLLMProvider, ProviderRegistry, createUserMessage } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { sessionMemoryDir } from '../../__fixtures__/session-memory.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { resolveNamzuHome } from '../../integrations/state/home.js'
import { createAgentSession } from '../agent.js'

const roots: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	for (const root of roots.splice(0)) removeTempDir(root)
})

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'anthropic', model: 'claude-sonnet-5' }],
	subagents: { active: [] },
}
const detected: DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY['anthropic'],
		source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]

async function oneTurn(cwd: string): Promise<void> {
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({
		provider: new MockLLMProvider({ turns: [{ text: 'ok' }] }),
	} as never)
	const session = await createAgentSession(preferences, detected, {
		cwd,
		sandbox: { enabled: false },
	})
	try {
		expect(session.hasProvider, session.errorHint ?? undefined).toBe(true)
		for await (const _event of session.send([createUserMessage('hello')])) {
			/* drain */
		}
	} finally {
		await session.close()
	}
}

it('writes nothing into the working directory', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-untouched-cwd-'))
	roots.push(cwd)

	await oneTurn(cwd)

	expect(await readdir(cwd)).toEqual([])
	// The run went somewhere: the application home the suite owns.
	expect(existsSync(join(resolveNamzuHome(), 'sessions'))).toBe(true)
})

it('files two sessions in one directory under one Project', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-one-project-'))
	roots.push(cwd)
	const memory = join(resolveNamzuHome(), 'memory')
	const before = new Set(existsSync(memory) ? await readdir(memory) : [])

	await oneTurn(cwd)
	await oneTurn(cwd)

	const added = (await readdir(memory)).filter((name) => !before.has(name))
	expect(added).toEqual([basename(sessionMemoryDir(cwd))])
})
