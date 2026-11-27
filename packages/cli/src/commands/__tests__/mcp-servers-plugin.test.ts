import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { installFixture } from '../../__fixtures__/installed-plugin.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { runCli } from '../../cli.js'
import { recordLayerPath, setEnabledPlugin } from '../../integrations/plugins/enabled-records.js'
import { trustDir } from '../../integrations/trust/store.js'

const roots: string[] = []
const initialCwd = process.cwd()

afterEach(() => {
	process.chdir(initialCwd)
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	for (const root of roots.splice(0)) removeTempDir(root)
})

it('lists a plugin remote server as waiting, approves it by name, and names what its headers read', async () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-mcp-plugin-home-'))
	const project = mkdtempSync(join(tmpdir(), 'namzu-mcp-plugin-proj-'))
	roots.push(home, project)
	vi.stubEnv('NAMZU_HOME', home)
	vi.stubEnv('LEDGER_TOKEN', 'x')
	writeFileSync(join(home, 'config.yaml'), 'plugins:\n  enabled: true\n')
	installFixture(home, {
		id: 'ledger@m',
		layout: 'common',
		executable: [],
		files: {
			'.claude-plugin/plugin.json': { name: 'ledger', version: '1.0.0', description: 'x' },
			'.mcp.json': {
				mcpServers: {
					api: {
						url: 'https://mcp.example.com/v1',
						headers: { Authorization: 'Bearer ${LEDGER_TOKEN}' },
					},
					unset: { url: 'https://o.example.com/', headers: { A: '${MISSING_ONE}' } },
				},
			},
		},
	})
	mkdirSync(project, { recursive: true })
	setEnabledPlugin(recordLayerPath('user', { home, cwd: project }), home, 'ledger@m', true)
	trustDir(project)
	process.chdir(project)
	let stdout = ''
	let stderr = ''
	vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		stdout += String(chunk)
		return true
	})
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
		stderr += String(chunk)
		return true
	})
	const run = (...args: string[]) =>
		runCli({ argv: ['node', 'namzu', '--format', 'json', 'mcp', ...args] })
	const rows = async () => {
		stdout = ''
		expect(await run('servers')).toBe(0)
		return JSON.parse(stdout).servers as { name: string; state: string; source: string }[]
	}

	expect(await rows()).toEqual([
		expect.objectContaining({ name: 'ledger-api', state: 'waiting', source: 'Plugin ledger' }),
		expect.objectContaining({
			name: 'ledger-unset',
			state: 'needs-setup',
			source: 'Plugin ledger',
		}),
	])

	// A server that needs setup cannot be approved, and says why.
	expect(await run('approve', 'ledger-unset')).not.toBe(0)
	expect(stderr).toContain('MISSING_ONE')

	stdout = ''
	expect(await run('approve', 'ledger-api')).toBe(0)
	const answer = JSON.parse(stdout)
	expect(answer.approved).toEqual(['ledger-api'])
	expect(answer.text).toContain('https://mcp.example.com')
	expect(answer.text).toContain('LEDGER_TOKEN')
	expect((await rows()).find((row) => row.name === 'ledger-api')?.state).toBe('idle')
	const file = JSON.parse(readFileSync(join(home, 'mcp-approvals.json'), 'utf8'))
	expect(Object.keys(file.plugins['ledger@m'])).toEqual(['api'])

	// Nothing left to approve with no name given.
	stdout = ''
	expect(await run('approve')).toBe(0)
	expect(JSON.parse(stdout).approved).toEqual([])
})
