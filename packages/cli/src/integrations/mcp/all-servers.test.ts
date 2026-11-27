import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { installFixture } from '../../__fixtures__/installed-plugin.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { recordLayerPath, setEnabledPlugin } from '../plugins/enabled-records.js'
import { trustDir } from '../trust/store.js'
import { approveListedAnyMcpServers, listAllMcpServers } from './all-servers.js'

let root: string
let home: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-all-servers-'))
	home = join(root, 'home')
	cwd = join(root, 'app')
	mkdirSync(home, { recursive: true })
	mkdirSync(cwd, { recursive: true })
	vi.stubEnv('NAMZU_HOME', home)
	vi.stubEnv('LEDGER_TOKEN', 'x')
	installFixture(home, {
		id: 'ledger@m',
		layout: 'common',
		executable: [],
		files: {
			'.claude-plugin/plugin.json': { name: 'ledger', version: '1.0.0', description: 'x' },
			'.mcp.json': { mcpServers: { api: { url: 'https://mcp.example.com/v1' } } },
		},
	})
	setEnabledPlugin(recordLayerPath('user', { home, cwd }), home, 'ledger@m', true)
	trustDir(cwd)
})
afterEach(() => {
	vi.unstubAllEnvs()
	removeTempDir(root)
})

const live = { connected: [] as string[], failed: [] as { name: string; reason: string }[] }

it('adds a plugin’s remote server to the project list with the plugin as its source, and nothing while plugins are off', async () => {
	const on = await listAllMcpServers({ cwd, live, plugins: { enabled: true } })
	expect(on.servers).toEqual([
		expect.objectContaining({
			name: 'ledger-api',
			origin: 'plugin',
			plugin: 'ledger',
			state: 'waiting',
		}),
	])
	const off = await listAllMcpServers({ cwd, live, plugins: undefined })
	expect(off.servers).toEqual([])
})

it('approves what the Connectors table sent by name, and a changed fingerprint stays waiting', async () => {
	const plugins = { enabled: true }
	const [row] = (await listAllMcpServers({ cwd, live, plugins })).servers
	expect(row?.fingerprint).toBeDefined()
	expect(
		await approveListedAnyMcpServers({
			cwd,
			plugins,
			shown: [{ name: 'ledger-api', fingerprint: 'stale' }],
		}),
	).toEqual(['ledger-api'])
	// The stale print was recorded but matches nothing the plugin declares now.
	expect((await listAllMcpServers({ cwd, live, plugins })).servers[0]?.state).toBe('waiting')
	await approveListedAnyMcpServers({
		cwd,
		plugins,
		shown: [{ name: 'ledger-api', fingerprint: row?.fingerprint as string }],
	})
	expect((await listAllMcpServers({ cwd, live, plugins })).servers[0]?.state).toBe('idle')
	// A live connection and a late failure show on the row.
	expect(
		(await listAllMcpServers({ cwd, live: { connected: ['ledger-api'], failed: [] }, plugins }))
			.servers[0]?.state,
	).toBe('connected')
	expect(
		(
			await listAllMcpServers({
				cwd,
				live: { connected: [], failed: [{ name: 'ledger-api', reason: 'No answer.' }] },
				plugins,
			})
		).servers[0],
	).toMatchObject({ state: 'failed', reason: 'No answer.' })
})

it('leaves a project server of the same name to the project and records nothing for the plugin', async () => {
	const plugins = { enabled: true }
	writeFileSync(
		join(cwd, '.mcp.json'),
		JSON.stringify({ mcpServers: { 'ledger-api': { url: 'https://project.example.com/' } } }),
	)
	const rows = (await listAllMcpServers({ cwd, live, plugins })).servers
	expect(rows.filter((row) => row.name === 'ledger-api')).toHaveLength(1)
	expect(rows.find((row) => row.name === 'ledger-api')?.origin).not.toBe('plugin')
	const shown = [{ name: 'ledger-api', fingerprint: rows[0]?.fingerprint ?? 'x' }]
	await approveListedAnyMcpServers({ cwd, plugins, shown })
	let approvals = ''
	try {
		approvals = readFileSync(join(home, 'mcp-approvals.json'), 'utf8')
	} catch {}
	expect(approvals).not.toContain('ledger@m')
})
