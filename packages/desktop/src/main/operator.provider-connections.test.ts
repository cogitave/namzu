import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { DesktopEvent } from '../shared/protocol.js'
import { Operator } from './operator.js'

const operators: Operator[] = []
const folders: string[] = []
afterEach(async () => {
	await Promise.all(operators.splice(0).map((owner) => owner.close()))
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})
function harness(env: NodeJS.ProcessEnv = {}) {
	const recorded: DesktopEvent[] = []
	const registry = mkdtempSync(join(tmpdir(), 'namzu-provider-setup-'))
	folders.push(registry)
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: { ...process.env, FIXTURE_PROVIDER_SETUP: '1', ...env },
		},
		(event) => recorded.push(event),
		registry,
	)
	operators.push(owner)
	return { owner, recorded, registry }
}

const SECRET = 'sk-fixture-secret-value-1234'

it('lists providers, saves a key, checks it and removes it without the key ever coming back', async () => {
	const { owner, recorded } = harness()
	const before = await owner.providerConnections()
	expect(before.map((row) => row.state)).toEqual(['not-connected', 'not-connected'])
	// A field the host should not have sent never reaches the window.
	expect(JSON.stringify(before)).not.toContain('MUST_NOT_REACH_THE_WINDOW')

	const saved = await owner.saveProviderKey('openai', `  ${SECRET}  `)
	expect(saved.find((row) => row.id === 'openai')).toMatchObject({
		state: 'connected',
		how: 'saved-key',
		hasSavedKey: true,
	})
	expect(JSON.stringify(saved)).not.toContain(SECRET)
	expect(recorded.filter((event) => event.kind === 'providers-changed')).toHaveLength(1)

	expect(await owner.testProvider('openai')).toBe('ok')
	expect(await owner.testProvider('anthropic')).toBe('missing')
	await owner.saveProviderKey('anthropic', SECRET)
	expect(await owner.testProvider('anthropic')).toBe('rejected')

	const removed = await owner.removeProviderKey('openai')
	expect(removed.find((row) => row.id === 'openai')?.hasSavedKey).toBe(false)
	expect(recorded.filter((event) => event.kind === 'providers-changed')).toHaveLength(3)
	// Nothing the operator emitted or returned holds the key.
	expect(JSON.stringify(recorded)).not.toContain(SECRET)
})

it('refuses malformed provider and key input before it reaches the host', async () => {
	const { owner } = harness()
	await expect(owner.saveProviderKey('', SECRET)).rejects.toThrow('Choose a provider')
	await expect(owner.saveProviderKey(7, SECRET)).rejects.toThrow('Choose a provider')
	await expect(owner.saveProviderKey('openai', '   ')).rejects.toThrow('Paste an API key')
	await expect(owner.saveProviderKey('openai', 'x'.repeat(4097))).rejects.toThrow('too long')
	await expect(owner.removeProviderKey('')).rejects.toThrow('Choose a provider')
	await expect(owner.testProvider({})).rejects.toThrow('Choose a provider')
})

it('asks every open project to forget its cached providers when a key changes', async () => {
	const log = join(mkdtempSync(join(tmpdir(), 'namzu-provider-log-')), 'requests.jsonl')
	folders.push(join(log, '..'))
	const { owner } = harness({ FIXTURE_REQUEST_LOG: log })
	const project = await owner.openProject(process.cwd())
	await owner.saveProviderKey('openai', SECRET)
	const methods = readFileSync(log, 'utf8')
		.trim()
		.split('\n')
		.map((line) => (JSON.parse(line) as { method: string }).method)
	// The registry host saved the key; the project's own host was told to refresh.
	expect(methods.filter((method) => method === 'namzu/providers/save_key')).toHaveLength(1)
	expect(methods.filter((method) => method === 'namzu/providers/refresh')).toHaveLength(1)
	expect(project.status).toBe('ready')
})
