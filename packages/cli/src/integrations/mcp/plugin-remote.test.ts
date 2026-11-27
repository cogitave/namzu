import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installFixture } from '../../__fixtures__/installed-plugin.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { recordLayerPath, setEnabledPlugin } from '../plugins/enabled-records.js'
import {
	type PluginRemoteServer,
	createPluginRemoteHost,
	fingerprintOf,
	pluginRemoteRows,
	pluginServerApproved,
	pluginServerRuntimeName,
	readInstalledRemoteServers,
	uniqueRuntimeNames,
} from './plugin-remote.js'
import { approveShownPluginMcpServers, mcpApprovalsPath } from './project-approval.js'
import * as servers from './servers.js'

vi.mock('./servers.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./servers.js')>()),
	startMcpServers: vi.fn(),
}))

let root: string
let home: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-plugin-remote-'))
	home = join(root, 'home')
	cwd = join(root, 'app')
	mkdirSync(home, { recursive: true })
	mkdirSync(cwd, { recursive: true })
	vi.stubEnv('NAMZU_HOME', home)
	vi.stubEnv('LEDGER_TOKEN', undefined as unknown as string)
	vi.mocked(servers.startMcpServers).mockReset()
})
afterEach(() => {
	vi.unstubAllEnvs()
	removeTempDir(root)
})

const MCP = '.mcp.json'
const PLUGIN = '.claude-plugin/plugin.json'
const manifest = (name: string) => ({ name, version: '1.0.0', description: `The ${name} plugin.` })

function install(id: string, mcp: Record<string, unknown>, options: { on?: boolean } = {}): void {
	const name = id.split('@')[0] as string
	installFixture(home, {
		id,
		layout: 'common',
		executable: [],
		files: { [PLUGIN]: manifest(name), [MCP]: { mcpServers: mcp } },
	})
	setEnabledPlugin(recordLayerPath('user', { home, cwd }), home, id, options.on !== false)
}

const read = () =>
	readInstalledRemoteServers({
		home,
		cwd,
		projectTrusted: true,
		allowedScopes: ['project', 'user'],
	})

const api = {
	url: 'https://mcp.example.com/v1',
	headers: { Authorization: 'Bearer ${LEDGER_TOKEN}' },
}

describe('reading the remote servers of installed plugins', () => {
	it('lists a remote server of a plugin that is on, and none of a plugin that is off', async () => {
		vi.stubEnv('LEDGER_TOKEN', 'secret-value')
		install('ledger@m', { api })
		install('quiet@m', { api: { url: 'https://other.example.com/' } }, { on: false })
		const { servers: found } = await read()
		expect(found.map((s) => s.runtimeName)).toEqual(['ledger-api'])
		expect(found[0]).toMatchObject({
			pluginId: 'ledger@m',
			pluginName: 'ledger',
			server: 'api',
			detail: 'https://mcp.example.com',
			spec: { url: 'https://mcp.example.com/v1' },
		})
		// The header keeps its reference as written; the value is never read into the listing.
		expect(JSON.stringify(found)).not.toContain('secret-value')
	})

	it('marks a server whose header variable is unset as needing setup, with no spec to start', async () => {
		install('ledger@m', { api })
		const { servers: found } = await read()
		expect(found).toHaveLength(1)
		expect(found[0]?.needsSetup).toContain('LEDGER_TOKEN is not set')
		expect(found[0]?.spec).toBeUndefined()
		const [row] = pluginRemoteRows(home, found, { connected: [], failed: [] })
		expect(row).toMatchObject({ origin: 'plugin', plugin: 'ledger', state: 'needs-setup' })
		expect(row?.reason).toContain('LEDGER_TOKEN')
	})

	it('marks a server that uses an environment reference in its address as needing setup', async () => {
		vi.stubEnv('REGION', 'eu')
		install('ledger@m', { api: { url: 'https://${REGION}.example.com/' } })
		const { servers: found } = await read()
		expect(found[0]?.needsSetup).toContain('not expanded')
		expect(found[0]?.spec).toBeUndefined()
	})

	it('substitutes the plugin folder names in a header and the address', async () => {
		vi.stubEnv('LEDGER_TOKEN', 'x')
		install('ledger@m', {
			api: { url: 'https://mcp.example.com/${CLAUDE_PLUGIN_ROOT}', headers: { A: 'b' } },
		})
		const { servers: found } = await read()
		expect(found[0]?.spec?.url).toMatch(/^https:\/\/mcp\.example\.com\//)
		expect(found[0]?.spec?.url).not.toContain('${')
	})
})

describe('approval of a plugin remote server', () => {
	async function one(overrides: Record<string, unknown> = {}): Promise<PluginRemoteServer> {
		vi.stubEnv('LEDGER_TOKEN', 'x')
		install('ledger@m', { api: { ...api, ...overrides } })
		const server = (await read()).servers[0]
		if (!server) throw new Error('no server')
		return server
	}

	it('is waiting until approved, and approved after', async () => {
		const server = await one()
		expect(pluginServerApproved(home, server)).toBe(false)
		const [waiting] = pluginRemoteRows(home, [server], { connected: [], failed: [] })
		expect(waiting?.state).toBe('waiting')
		expect(waiting?.fingerprint).toBe(fingerprintOf(server))
		approveShownPluginMcpServers(home, [
			{ pluginId: 'ledger@m', server: 'api', fingerprint: fingerprintOf(server) },
		])
		expect(pluginServerApproved(home, server)).toBe(true)
		const [idle] = pluginRemoteRows(home, [server], { connected: [], failed: [] })
		expect(idle?.state).toBe('idle')
	})

	it('asks again when the address, a header or the transport changes', async () => {
		const first = await one()
		approveShownPluginMcpServers(home, [
			{ pluginId: 'ledger@m', server: 'api', fingerprint: fingerprintOf(first) },
		])
		for (const change of [
			{ url: 'https://mcp.example.com/v2' },
			{ headers: { Authorization: 'Bearer ${LEDGER_TOKEN}', 'X-Extra': 'y' } },
			{ type: 'sse' },
		]) {
			install('ledger@m', { api: { ...api, ...change } })
			const changed = (await read()).servers[0] as PluginRemoteServer
			expect(fingerprintOf(changed)).not.toBe(fingerprintOf(first))
			expect(pluginServerApproved(home, changed)).toBe(false)
		}
	})

	it('is scoped to the plugin id and the server name', async () => {
		vi.stubEnv('LEDGER_TOKEN', 'x')
		install('ledger@m', { api, other: { url: 'https://o.example.com/' } })
		install('twin@m', { api })
		const found = (await read()).servers
		const by = (name: string) => found.find((s) => s.runtimeName === name) as PluginRemoteServer
		approveShownPluginMcpServers(home, [
			{ pluginId: 'ledger@m', server: 'api', fingerprint: fingerprintOf(by('ledger-api')) },
		])
		expect(pluginServerApproved(home, by('ledger-api'))).toBe(true)
		expect(pluginServerApproved(home, by('ledger-other'))).toBe(false)
		// Same address and headers under another plugin: its own answer is still needed.
		expect(pluginServerApproved(home, by('twin-api'))).toBe(false)
	})

	it('keeps the project folders in the approvals file as they were', async () => {
		const server = await one()
		const path = mcpApprovalsPath(home)
		mkdirSync(home, { recursive: true })
		const { writeFileSync } = await import('node:fs')
		writeFileSync(path, JSON.stringify({ version: 1, folders: { '/x': { a: 'print' } }, extra: 1 }))
		approveShownPluginMcpServers(home, [
			{ pluginId: 'ledger@m', server: 'api', fingerprint: fingerprintOf(server) },
		])
		const written = JSON.parse(readFileSync(path, 'utf8'))
		expect(written.folders).toEqual({ '/x': { a: 'print' } })
		expect(written.extra).toBe(1)
		expect(written.plugins['ledger@m'].api).toBe(fingerprintOf(server))
	})

	it('approves nothing while the approvals file cannot be read', async () => {
		const server = await one()
		const { writeFileSync } = await import('node:fs')
		writeFileSync(mcpApprovalsPath(home), '{ not json')
		expect(pluginServerApproved(home, server)).toBe(false)
	})
})

describe('the live connections of a session', () => {
	const connection = () => ({
		toolsets: [],
		current: () => ({ connected: [], failed: [], pending: [] }),
		onSettled: () => () => {},
		close: vi.fn(async () => {}),
	})

	async function host(on: { value: boolean }) {
		vi.stubEnv('LEDGER_TOKEN', 'x')
		install('ledger@m', { api })
		const found = (await read()).servers
		const made = createPluginRemoteHost({
			home,
			servers: found,
			isOn: () => on.value,
			start: { cwd },
		})
		return { made, server: found[0] as PluginRemoteServer }
	}

	it('connects nothing before approval', async () => {
		const { made } = await host({ value: true })
		made.sync()
		expect(servers.startMcpServers).not.toHaveBeenCalled()
		expect(made.status()).toEqual({ connected: [], failed: [] })
	})

	it('connects after approval, once, under the plugin-qualified name', async () => {
		const { made, server } = await host({ value: true })
		approveShownPluginMcpServers(home, [
			{ pluginId: 'ledger@m', server: 'api', fingerprint: fingerprintOf(server) },
		])
		vi.mocked(servers.startMcpServers).mockReturnValue(connection() as never)
		made.sync()
		made.sync()
		expect(servers.startMcpServers).toHaveBeenCalledTimes(1)
		expect(vi.mocked(servers.startMcpServers).mock.calls[0]?.[0]).toEqual({
			'ledger-api': { url: 'https://mcp.example.com/v1', headers: api.headers },
		})
	})

	it('does not start the server of a plugin that is off, and disconnects it when turned off', async () => {
		const on = { value: false }
		const { made, server } = await host(on)
		approveShownPluginMcpServers(home, [
			{ pluginId: 'ledger@m', server: 'api', fingerprint: fingerprintOf(server) },
		])
		const live = connection()
		vi.mocked(servers.startMcpServers).mockReturnValue(live as never)
		made.sync()
		expect(servers.startMcpServers).not.toHaveBeenCalled()
		on.value = true
		made.sync()
		expect(servers.startMcpServers).toHaveBeenCalledTimes(1)
		on.value = false
		made.sync()
		expect(live.close).toHaveBeenCalledTimes(1)
	})

	it('stops showing a server as live once its approval is gone from disk', async () => {
		const { made, server } = await host({ value: true })
		approveShownPluginMcpServers(home, [
			{ pluginId: 'ledger@m', server: 'api', fingerprint: fingerprintOf(server) },
		])
		const live = {
			...connection(),
			current: () => ({ connected: ['ledger-api'], failed: [], pending: [] }),
		}
		vi.mocked(servers.startMcpServers).mockReturnValue(live as never)
		made.sync()
		expect(made.status().connected).toEqual(['ledger-api'])
		writeFileSync(mcpApprovalsPath(home), '{}')
		expect(made.status().connected).toEqual([])
		expect(live.close).toHaveBeenCalledTimes(1)
	})

	it('never starts a server that needs setup, even when it was approved before', async () => {
		install('ledger@m', { api })
		const found = (await read()).servers
		expect(found[0]?.needsSetup).toBeDefined()
		const made = createPluginRemoteHost({ home, servers: found, isOn: () => true, start: { cwd } })
		made.sync()
		expect(servers.startMcpServers).not.toHaveBeenCalled()
	})

	it('closes every connection when the session closes', async () => {
		const { made, server } = await host({ value: true })
		approveShownPluginMcpServers(home, [
			{ pluginId: 'ledger@m', server: 'api', fingerprint: fingerprintOf(server) },
		])
		const live = connection()
		vi.mocked(servers.startMcpServers).mockReturnValue(live as never)
		made.sync()
		await made.close()
		expect(live.close).toHaveBeenCalledTimes(1)
		made.sync()
		expect(servers.startMcpServers).toHaveBeenCalledTimes(1)
	})
})

describe('the name a plugin server has in the roster', () => {
	it('joins the plugin and server names and keeps to the characters a server name allows', () => {
		expect(pluginServerRuntimeName('ledger', 'api')).toBe('ledger-api')
		expect(pluginServerRuntimeName('my.plugin', 'a b')).toBe('my_plugin-a_b')
		expect(pluginServerRuntimeName('1x', 'y')).toBe('p1x-y')
		expect(pluginServerRuntimeName('a'.repeat(80), 'b')).toHaveLength(64)
	})

	it('gives two plugins that build the same name two different names', async () => {
		install('a-b@m', { c: api })
		install('a@m', { 'b-c': { url: 'https://two.example.com/' } })
		const names = (await read()).servers.map((s) => s.runtimeName)
		expect(names).toHaveLength(2)
		expect(new Set(names).size).toBe(2)
		const fake = (runtimeName: string) => ({ runtimeName }) as PluginRemoteServer
		expect(uniqueRuntimeNames([fake('x'), fake('x'), fake('x')]).map((s) => s.runtimeName)).toEqual(
			['x', 'x-2', 'x-3'],
		)
	})

	it('names the header variables a waiting server will send', async () => {
		vi.stubEnv('LEDGER_TOKEN', 'x')
		install('ledger@m', { api })
		const [server] = (await read()).servers
		const [row] = pluginRemoteRows(home, [server as PluginRemoteServer], {
			connected: [],
			failed: [],
		})
		expect(row?.sends).toEqual(['LEDGER_TOKEN'])
	})
})
