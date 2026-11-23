import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { BROWSER_PANE_CAPABILITY, createAcpPaneLink } from '../acp-browser-pane.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'

/**
 * The desktop runs `namzu acp --desktop`; the host `computer_use` tool is only
 * mounted when the session is built with `enableComputerUse`. These tests read
 * the options the runtime hands the session builder. No session is real and no
 * desktop is touched.
 */

let root: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-acp-desktop-cu-'))
	cwd = join(root, 'project')
	mkdirSync(cwd)
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

async function optionsSeen(
	runtimeOptions?: Parameters<typeof createCliAcpRuntime>[2],
	config: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	let seen: Record<string, unknown> = {}
	const deps = {
		probe: async () => ({
			preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
			detected: [],
		}),
		decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
		resolveProjectContext: (value: unknown) => value,
		resolveSession: async (sessionId: string) => ({ sessionId }),
		createSession: async (_p: unknown, _d: unknown, options: Record<string, unknown>) => {
			seen = options
			return {
				hasProvider: true,
				errorHint: null,
				mcpFailed: [],
				send: async function* () {
					yield { kind: 'done', stopReason: 'end_turn' }
				},
				close: async () => {},
				presenter: {
					presentCall: () => ({ kind: 'generic', label: 'Fixture' }),
					presentResult: () => ({ kind: 'generic', label: 'Fixture' }),
				},
				jobs: () => [],
			}
		},
	} as unknown as AcpRuntimeDependencies
	const runtime = createCliAcpRuntime(
		{ config, formatter: { name: 'text', print() {}, info() {}, error() {} } },
		deps,
		runtimeOptions,
	)
	await runtime.gateway.prompt({
		sessionId: 'session-cu',
		cwd,
		prompt: 'hello',
		history: [],
		signal: new AbortController().signal,
		onEvent() {},
		ask: async () => ({ kind: 'approve' }),
		filesystem: undefined,
	})
	return seen
}

it('mounts the host computer for the desktop once computer use is turned on', async () => {
	const seen = await optionsSeen({ computerUse: true }, { computerUse: { enabled: true } })
	expect(seen.enableComputerUse).toBe(true)
})

it('offers the host computer to the desktop with a switch that follows the setting', async () => {
	const off = await optionsSeen({ computerUse: true })
	expect(off.enableComputerUse).toBe(true)
	expect((off.computerUseSwitch as () => boolean)()).toBe(false)
	const disabled = await optionsSeen({ computerUse: true }, { computerUse: { enabled: false } })
	expect((disabled.computerUseSwitch as () => boolean)()).toBe(false)
	const on = await optionsSeen({ computerUse: true }, { computerUse: { enabled: true } })
	expect((on.computerUseSwitch as () => boolean)()).toBe(true)
	// The apps on the list still reach the session.
	expect(
		(
			await optionsSeen(
				{ computerUse: true },
				{ computerUse: { enabled: true, deniedApps: ['Banking'] } },
			)
		).deniedComputerApps,
	).toEqual(['Banking'])
})

it('reads the switch again between two turns of one session', async () => {
	let enabled = false
	let seen: Record<string, unknown> = {}
	const deps = {
		probe: async () => ({
			preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
			detected: [],
		}),
		decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
		resolveProjectContext: () => ({
			config: { computerUse: { enabled } },
			formatter: { name: 'text', print() {}, info() {}, error() {} },
		}),
		resolveSession: async (sessionId: string) => ({ sessionId }),
		createSession: async (_p: unknown, _d: unknown, options: Record<string, unknown>) => {
			seen = options
			return {
				hasProvider: true,
				errorHint: null,
				mcpFailed: [],
				send: async function* () {
					yield { kind: 'done', stopReason: 'end_turn' }
				},
				close: async () => {},
				presenter: {
					presentCall: () => ({ kind: 'generic', label: 'Fixture' }),
					presentResult: () => ({ kind: 'generic', label: 'Fixture' }),
				},
				jobs: () => [],
			}
		},
	} as unknown as AcpRuntimeDependencies
	const runtime = createCliAcpRuntime(
		{ config: {}, formatter: { name: 'text', print() {}, info() {}, error() {} } },
		deps,
		{ computerUse: true },
	)
	await runtime.gateway.prompt({
		sessionId: 'session-cu-live',
		cwd,
		prompt: 'hello',
		history: [],
		signal: new AbortController().signal,
		onEvent() {},
		ask: async () => ({ kind: 'approve' }),
		filesystem: undefined,
	})
	const computerUseSwitch = seen.computerUseSwitch as () => boolean
	expect(computerUseSwitch()).toBe(false)
	enabled = true
	expect(computerUseSwitch()).toBe(true)
	enabled = false
	expect(computerUseSwitch()).toBe(false)
})

it('leaves a bare ACP client without it', async () => {
	const on = { computerUse: { enabled: true } }
	expect('enableComputerUse' in (await optionsSeen(undefined, on))).toBe(false)
	expect('enableComputerUse' in (await optionsSeen({ computerUse: false }, on))).toBe(false)
})

it('mounts the browser tools for the desktop with the config the terminal reads', async () => {
	const seen = await optionsSeen(
		{ computerUse: true },
		{
			browser: {
				defaultProfile: 'work',
				headless: 'always',
				sites: { 'https://example.com': 'act' },
				signInDetection: 'page',
			},
		},
	)
	expect(seen.browser).toMatchObject({
		profile: 'work',
		headless: 'always',
		signInDetection: 'page',
		sites: { 'https://example.com': 'act', '*': 'ask' },
	})
	// The site rules ride in front of the permission table.
	expect((seen.rules as unknown[]).length).toBeGreaterThan(0)
})

it('mounts the browser tools for the desktop with no browser config at all, asking about every site', async () => {
	const seen = await optionsSeen({ computerUse: true })
	expect(seen.browser).toMatchObject({ sites: { '*': 'ask' } })
})

it('leaves a bare ACP client and a switched-off browser without them', async () => {
	expect('browser' in (await optionsSeen())).toBe(false)
	expect('browser' in (await optionsSeen({ computerUse: false }))).toBe(false)
	expect(
		'browser' in (await optionsSeen({ computerUse: true }, { browser: { enabled: false } })),
	).toBe(false)
})

const paneLink = (offered: boolean) =>
	createAcpPaneLink({
		offers: (capability) => offered && capability === BROWSER_PANE_CAPABILITY,
		ask: async () => ({}),
	})
const paneOf = (seen: Record<string, unknown>) => (seen.browser as { pane?: () => unknown }).pane

it('hands the browser the Browser pane when the app named it at initialize', async () => {
	const link = paneLink(true)
	const seen = await optionsSeen({ computerUse: true, browserPane: link })
	expect(paneOf(seen)?.()).toBeDefined()
	// A connection that ended offers nothing more: the browser opens its own.
	link.close('gone')
	expect(paneOf(seen)?.()).toBeUndefined()
})

it('leaves the pane out for an app that did not name it, and for a browser set to never show a window', async () => {
	expect(paneOf(await optionsSeen({ computerUse: true, browserPane: paneLink(false) }))?.()).toBe(
		undefined,
	)
	const link = paneLink(true)
	expect(
		paneOf(
			await optionsSeen(
				{ computerUse: true, browserPane: link },
				{ browser: { headless: 'always' } },
			),
		),
	).toBeUndefined()
	// Without a pane link (a bare client, an older host) the browser options are as they were.
	expect(paneOf(await optionsSeen({ computerUse: true }))).toBeUndefined()
})

it('passes the site rules the app enforces under the engine’s own', async () => {
	const asked: Record<string, unknown>[] = []
	const recording = createAcpPaneLink({
		offers: () => true,
		ask: async (_method, params) => {
			asked.push(params)
			return { tabId: 't1' }
		},
	})
	const seen = await optionsSeen(
		{ computerUse: true, browserPane: recording },
		{ browser: { sites: { 'https://bank.example': 'deny' } } },
	)
	const channel = paneOf(seen)?.() as { listTabs(): Promise<unknown> }
	await channel.listTabs()
	expect(asked[0]).toMatchObject({ rules: { deny: ['bank.example'] } })
})
