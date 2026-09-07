import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { discoverProviders, findDetected, signedInSubscriptionProviders } from './discover.js'
import { opencodeCredentialsPath } from './harness-credentials.js'

let home: string
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-zen-discovery-'))
})
afterEach(() => {
	removeTempDir(home)
})
const writeAuth = (path: string, value: unknown) => {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
}
const discover = (env: NodeJS.ProcessEnv = {}, windowsHome?: string) =>
	discoverProviders({
		home,
		env,
		windowsHome,
		skipProbes: true,
		skipKeychain: true,
		skipStored: true,
	})

it('offers public Zen without an install, key, sign-in or network probe', async () => {
	const detected = await discover()
	expect(detected.map((provider) => provider.entry.id)).toEqual(['zen'])
	expect(detected[0]).toMatchObject({
		source: { kind: 'public' },
		entry: { defaultModel: 'muse-spark-1.3-contributor-free' },
	})
	expect(detected[0]?.apiKey).toBeUndefined()
	expect(signedInSubscriptionProviders(detected)).toEqual([])
})

it('keeps genuine credentials before the public headless fallback', async () => {
	expect(
		(await discover({ OPENAI_API_KEY: 'openai-fixture' })).map((provider) => provider.entry.id),
	).toEqual(['openai', 'zen'])
})

it('also orders an explicit anonymous environment selection after an account-backed provider', async () => {
	const detected = await discover({ OPENCODE_API_KEY: 'public', OPENCODE_GO_API_KEY: 'go-account' })
	expect(detected.map((provider) => provider.entry.id)).toEqual(['zen-go', 'zen'])
	expect(findDetected(detected, 'zen')).toMatchObject({
		source: { kind: 'env', envName: 'OPENCODE_API_KEY' },
	})
	expect(findDetected(detected, 'zen')?.apiKey).toBeUndefined()
})

it('borrows exact API entries independently and records the owner path', async () => {
	const path = opencodeCredentialsPath(home, {})
	writeAuth(path, {
		opencode: { type: 'api', key: 'zen-file' },
		'opencode-go': { type: 'api', key: 'go-file' },
	})
	const detected = await discover()
	expect(findDetected(detected, 'zen')).toMatchObject({
		apiKey: 'zen-file',
		source: { kind: 'opencode-file', path },
	})
	expect(findDetected(detected, 'zen-go')).toMatchObject({
		apiKey: 'go-file',
		source: { kind: 'opencode-file', path },
	})
	expect(signedInSubscriptionProviders(detected)).toEqual([])
})

it('prefers direct API environment values and retains the file as provenance', async () => {
	const path = opencodeCredentialsPath(home, {})
	writeAuth(path, { opencode: { type: 'api', key: 'file' } })
	expect(
		findDetected(
			await discover({
				OPENCODE_API_KEY: 'direct',
				OPENCODE_ZEN_API_KEY: 'alias',
			}),
			'zen',
		),
	).toMatchObject({
		apiKey: 'direct',
		source: { kind: 'env', envName: 'OPENCODE_API_KEY' },
		alternatives: [
			{ kind: 'env', envName: 'OPENCODE_ZEN_API_KEY' },
			{ kind: 'opencode-file', path },
		],
	})
})

it('uses explicit auth content before disk but after direct API environment values', async () => {
	writeAuth(opencodeCredentialsPath(home, {}), {
		opencode: { type: 'api', key: 'stale-file' },
	})
	const env = {
		OPENCODE_AUTH_CONTENT: JSON.stringify({
			opencode: { type: 'api', key: 'content' },
		}),
	}
	expect(findDetected(await discover(env), 'zen')).toMatchObject({
		apiKey: 'content',
		source: { kind: 'env', envName: 'OPENCODE_AUTH_CONTENT' },
	})
	expect(findDetected(await discover({ ...env, OPENCODE_API_KEY: 'direct' }), 'zen')?.apiKey).toBe(
		'direct',
	)
})

it.each([
	'',
	'not-json',
	'{}',
	JSON.stringify({ opencode: { type: 'oauth', access: 'oauth' } }),
	'x'.repeat(1024 * 1024 + 1),
])(
	'does not revive disk credentials after an unusable auth-content override (%#)',
	async (content) => {
		writeAuth(opencodeCredentialsPath(home, {}), {
			opencode: { type: 'api', key: 'stale-file' },
		})
		expect(findDetected(await discover({ OPENCODE_AUTH_CONTENT: content }), 'zen')?.source).toEqual(
			{ kind: 'public' },
		)
	},
)

it.each([
	{ opencode: { type: 'oauth', access: 'oauth' } },
	{
		zen: { type: 'api', key: 'alias' },
		'https://opencode.ai': { type: 'api', key: 'url' },
	},
	{
		opencode: { type: 'api', key: 'public' },
		'opencode-go': { type: 'api', key: 'public' },
	},
	{ opencode: { type: 'api', key: 123 } },
])('ignores unsupported or non-credential owner entries (%#)', async (content) => {
	writeAuth(opencodeCredentialsPath(home, {}), content)
	const detected = await discover()
	expect(findDetected(detected, 'zen')?.source).toEqual({ kind: 'public' })
	expect(findDetected(detected, 'zen-go')).toBeNull()
})

it('does not classify the public environment marker as an account credential', async () => {
	writeAuth(opencodeCredentialsPath(home, {}), {
		opencode: { type: 'api', key: 'paid-zen' },
		'opencode-go': { type: 'api', key: 'paid-go' },
	})
	const detected = await discover({
		OPENCODE_API_KEY: 'public',
		OPENCODE_ZEN_API_KEY: 'paid-alias',
		OPENCODE_GO_API_KEY: 'public',
	})
	expect(findDetected(detected, 'zen')?.apiKey).toBeUndefined()
	expect(findDetected(detected, 'zen')?.source).toEqual({
		kind: 'env',
		envName: 'OPENCODE_API_KEY',
	})
	expect(findDetected(detected, 'zen-go')).toBeNull()
})

it('honors an absolute XDG data home as the selected owner store', async () => {
	const xdg = join(home, 'xdg')
	const windowsHome = join(home, 'windows')
	writeAuth(opencodeCredentialsPath(home, {}), {
		opencode: { type: 'api', key: 'wrong-home' },
	})
	writeAuth(opencodeCredentialsPath(windowsHome, {}), {
		'opencode-go': { type: 'api', key: 'wrong-windows' },
	})
	const path = opencodeCredentialsPath(home, { XDG_DATA_HOME: xdg })
	writeAuth(path, { opencode: { type: 'api', key: 'xdg' } })
	const detected = await discover({ XDG_DATA_HOME: xdg }, windowsHome)
	expect(findDetected(detected, 'zen')).toMatchObject({
		apiKey: 'xdg',
		source: { kind: 'opencode-file', path },
	})
	expect(findDetected(detected, 'zen-go')).toBeNull()
})

it('can borrow from the paired Windows home when the Linux store has no API entry', async () => {
	const windowsHome = join(home, 'windows')
	const path = opencodeCredentialsPath(windowsHome, {})
	writeAuth(path, { opencode: { type: 'api', key: 'windows' } })
	expect(findDetected(await discover({}, windowsHome), 'zen')).toMatchObject({
		apiKey: 'windows',
		source: { kind: 'opencode-file', path },
	})
})

it('refuses an oversized owner file before parsing', async () => {
	writeAuth(opencodeCredentialsPath(home, {}), {
		opencode: { type: 'api', key: 'x'.repeat(1024 * 1024) },
	})
	expect(findDetected(await discover(), 'zen')?.source).toEqual({
		kind: 'public',
	})
})
