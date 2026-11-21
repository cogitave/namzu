import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider, ProviderRegistry } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { ensureRegistered } from '../../integrations/providers/register.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/registry.js'

// A trusted checkout whose .namzu still holds what an earlier Namzu kept in it:
// the session start tells git to leave that out of this clone, and says so
// once. A real git binary; nothing races a clock.
const roots: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	for (const root of roots.splice(0)) removeTempDir(root)
})

const detected: DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY['openai'],
		source: { kind: 'session' },
		apiKey: 'k',
		alternatives: [],
	},
]
const prefs: Preferences = {
	version: 3,
	providers: [{ id: 'openai', model: 'glm-fixture' }],
	subagents: { active: [] },
}

it('excludes the old state in this clone and says so once', { timeout: 60_000 }, async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-legacy-start-')))
	roots.push(root)
	const cwd = join(root, 'checkout')
	mkdirSync(join(cwd, '.namzu', 'sessions'), { recursive: true })
	writeFileSync(join(cwd, '.namzu', 'sessions', 'old.json'), '{}')
	mkdirSync(join(root, 'home'))
	vi.stubEnv('NAMZU_HOME', join(root, 'home'))
	execFileSync('git', ['init', '-q'], { cwd })
	await ensureRegistered('openai')
	vi.spyOn(ProviderRegistry, 'createProvider').mockImplementation(
		() => new MockLLMProvider({ responseText: 'done' }),
	)
	const { createAgentSession } = await import('../agent.js')
	const options = { cwd, ephemeral: true, folderTrusted: true, sandbox: { enabled: false } }

	const first = await createAgentSession(prefs, detected, options)
	const second = await createAgentSession(prefs, detected, options)
	try {
		expect(first.hasProvider, first.errorHint ?? undefined).toBe(true)
		expect(first.configNotices.filter((n) => n.includes('namzu state move-legacy'))).toHaveLength(1)
		expect(second.configNotices.some((n) => n.includes('namzu state move-legacy'))).toBe(false)
		expect(readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf8')).toContain(
			'/.namzu/sessions\n',
		)
	} finally {
		await first.close()
		await second.close()
	}
})
