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
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
	// The turn went somewhere: the project's directory under the application
	// home the suite owns, as one session log.
	const project = dirname(sessionMemoryDir(cwd))
	expect(existsSync(join(project, 'project.json'))).toBe(true)
	expect((await readdir(project)).filter((name) => name.endsWith('.jsonl'))).toHaveLength(1)
})

it('files two sessions in one directory under one Project', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-one-project-'))
	roots.push(cwd)
	const projects = join(resolveNamzuHome(), 'projects')
	const before = new Set(existsSync(projects) ? await readdir(projects) : [])

	await oneTurn(cwd)
	const project = dirname(sessionMemoryDir(cwd))
	const first = await readFile(join(project, 'project.json'), 'utf8')
	await oneTurn(cwd)

	// One project directory for the working directory, minted once, holding
	// both sessions' logs.
	const added = (await readdir(projects)).filter((name) => !before.has(name))
	expect(added).toEqual([basename(project)])
	expect(await readFile(join(project, 'project.json'), 'utf8')).toBe(first)
	expect((await readdir(project)).filter((name) => name.endsWith('.jsonl'))).toHaveLength(2)
})
