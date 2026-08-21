import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'

const mcp = vi.hoisted(() => ({
	mode: 'return' as 'return' | 'throw',
	close: vi.fn(async () => {}),
}))

vi.mock('../../integrations/mcp/servers.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/mcp/servers.js')>()
	return {
		...actual,
		connectMcpServers: vi.fn(async () => {
			if (mcp.mode === 'throw') throw new Error('mcp startup failed')
			return {
				tools: [],
				connected: [{ name: 'fixture', toolCount: 0, tools: [] }],
				failed: [],
				close: mcp.close,
			}
		}),
	}
})

const roots: string[] = []
const IMPORT_MARKER = '__namzuPluginBeforeMcpTest'

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

async function project(manifest: unknown, extra?: { name: string; body: string }): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-cli-plugin-startup-'))
	roots.push(cwd)
	const plugin = join(cwd, '.namzu', 'plugins', 'fixture')
	await mkdir(plugin, { recursive: true })
	await writeFile(join(plugin, 'plugin.json'), JSON.stringify(manifest), 'utf8')
	if (extra) await writeFile(join(plugin, extra.name), extra.body, 'utf8')
	return cwd
}

beforeEach(() => {
	mcp.mode = 'return'
	mcp.close.mockClear()
	delete (globalThis as Record<string, unknown>)[IMPORT_MARKER]
})

afterEach(() => {
	delete (globalThis as Record<string, unknown>)[IMPORT_MARKER]
	for (const root of roots.splice(0)) removeTempDir(root)
})

describe('plugin startup owns the resources around it', () => {
	it('does not import executable plugins before connector startup has succeeded', async () => {
		const cwd = await project(
			{
				name: 'fixture',
				version: '1.0.0',
				description: 'must not import early',
				hooks: ['hooks.mjs'],
			},
			{
				name: 'hooks.mjs',
				body: `globalThis.${IMPORT_MARKER} = true; export const hooks = [];\n`,
			},
		)
		mcp.mode = 'throw'
		const { createAgentSession } = await import('../agent.js')

		await expect(
			createAgentSession(preferences, detected, {
				cwd,
				plugins: { enabled: true, allowedScopes: ['project'] },
			}),
		).rejects.toThrow('mcp startup failed')
		expect((globalThis as Record<string, unknown>)[IMPORT_MARKER]).toBeUndefined()
	})

	it('closes connected servers when a plugin refuses the candidate session', async () => {
		const cwd = await project({ definitely: 'not a valid manifest' })
		const { createAgentSession } = await import('../agent.js')

		const session = await createAgentSession(preferences, detected, {
			cwd,
			plugins: { enabled: true, allowedScopes: ['project'] },
		})
		expect(session.hasProvider).toBe(false)
		expect(session.errorHint).toMatch(/Plugin runtime could not start/i)
		expect(mcp.close).toHaveBeenCalledOnce()
	})
})
