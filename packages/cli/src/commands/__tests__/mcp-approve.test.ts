import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { runCli } from '../../cli.js'
import { loadConfig, pendingProjectMcpServers } from '../../config/load.js'

const roots: string[] = []
const initialCwd = process.cwd()

afterEach(() => {
	process.chdir(initialCwd)
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	for (const root of roots.splice(0)) removeTempDir(root)
})

it('starts a project server only after `mcp approve`, and names an unknown one', async () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-mcp-approve-home-'))
	const project = mkdtempSync(join(tmpdir(), 'namzu-mcp-approve-proj-'))
	roots.push(home, project)
	vi.stubEnv('NAMZU_HOME', home)
	writeFileSync(
		join(project, '.mcp.json'),
		JSON.stringify({
			mcpServers: { tickets: { command: 'node' }, docs: { url: 'https://d.example/mcp' } },
		}),
	)
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

	expect(pendingProjectMcpServers({ cwd: project }).pending).toEqual(['tickets', 'docs'])

	expect(await run('approve', 'nope')).not.toBe(0)
	expect(stderr).toContain('nope')
	expect(pendingProjectMcpServers({ cwd: project }).pending).toEqual(['tickets', 'docs'])

	expect(await run('approve', 'docs')).toBe(0)
	expect(pendingProjectMcpServers({ cwd: project }).pending).toEqual(['tickets'])

	stdout = ''
	expect(await run('approve')).toBe(0)
	expect(JSON.parse(stdout).approved).toEqual(['tickets'])
	expect(pendingProjectMcpServers({ cwd: project }).pending).toEqual([])
	expect(Object.keys(loadConfig({ cwd: project }).mcpServers ?? {}).sort()).toEqual([
		'docs',
		'tickets',
	])
})
