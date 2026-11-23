import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { runCli } from '../../cli.js'
import { loadConfig } from '../../config/load.js'

const roots: string[] = []
const initialCwd = process.cwd()

afterEach(() => {
	process.chdir(initialCwd)
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	for (const root of roots.splice(0)) removeTempDir(root)
})

function setup(): {
	home: string
	project: string
	invoke: (...args: string[]) => Promise<{ code: number; stderr: string }>
} {
	const home = mkdtempSync(join(tmpdir(), 'namzu-mcp-forms-home-'))
	const project = mkdtempSync(join(tmpdir(), 'namzu-mcp-forms-project-'))
	roots.push(home, project)
	vi.stubEnv('NAMZU_HOME', home)
	process.chdir(project)
	let stderr = ''
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
		stderr += String(chunk)
		return true
	})
	const invoke = async (...args: string[]) => {
		stderr = ''
		const code = await runCli({ argv: ['node', 'namzu', 'mcp', ...args] })
		return { code, stderr }
	}
	return { home, project, invoke }
}

it('adds a server from one JSON object, checked like a config entry', async () => {
	const { home, invoke } = setup()
	const stdio = await invoke(
		'add',
		'json',
		'files',
		'{"command":"node","args":["server.js"],"env":{"A":"1"}}',
	)
	expect(stdio.code).toBe(0)
	const remote = await invoke(
		'add',
		'json',
		'search',
		'{"type":"http","url":"https://example.test/mcp","headers":{"Authorization":"Bearer ${TOKEN}"}}',
	)
	expect(remote.code).toBe(0)
	expect(loadConfig({ cwd: tmpdir(), env: { NAMZU_HOME: home } }).mcpServers).toMatchObject({
		files: { command: 'node', args: ['server.js'], env: { A: '1' } },
		search: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
	})
	// the type key is read and not saved
	expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain('type:')
})

it('refuses a JSON entry a session would refuse to start', async () => {
	const { home, invoke } = setup()
	for (const json of [
		'{"command":"node","url":"https://example.test/mcp"}',
		'{}',
		'{"command":"node","args":"not-a-list"}',
		'{"command":"node","connectTimeoutMs":-1}',
		'{"type":"sse","url":"https://example.test/mcp"}',
		'{"url":"https://example.test/mcp","headers":{"Authorization":"literal-secret"}}',
		'{"url":"https://user:pass@example.test/mcp"}',
	]) {
		const result = await invoke('add', 'json', 'bad', json)
		expect(result.code, json).toBe(64)
	}
	expect(existsSync(join(home, 'config.yaml'))).toBe(false)
})

it('reads json as an ordinary server name unless exactly a JSON object follows', async () => {
	const { home, invoke } = setup()
	// two arguments follow, the second is not a JSON object: "json" is the name
	expect((await invoke('add', 'json', 'node', 'server.js')).code).toBe(0)
	// a command named after a name, with more words after: still the name
	expect((await invoke('add', 'json2', '--', 'node', '{"a":1}')).code).toBe(0)
	expect((await invoke('add', 'json', '--url', 'https://example.test/x')).code).toBe(64) // duplicate name
	expect(loadConfig({ cwd: tmpdir(), env: { NAMZU_HOME: home } }).mcpServers).toMatchObject({
		json: { command: 'node', args: ['server.js'] },
		json2: { command: 'node', args: ['{"a":1}'] },
	})
})

it('writes a project server to .mcp.json, waiting for approval, and removes it', async () => {
	const { project, invoke } = setup()
	writeFileSync(join(project, '.mcp.json'), '{"other":1,"mcpServers":{"kept":{"command":"x"}}}')
	expect((await invoke('add', '-s', 'project', 'shared', '--', 'node', 'a.js')).code).toBe(0)
	expect((await invoke('add', '--scope', 'project', 'shared', '--', 'node', 'b.js')).code).toBe(64)
	const written = JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8')) as Record<
		string,
		unknown
	>
	expect(written).toEqual({
		other: 1,
		mcpServers: { kept: { command: 'x' }, shared: { command: 'node', args: ['a.js'] } },
	})
	expect((await invoke('remove', '-s', 'project', 'shared')).code).toBe(0)
	expect(JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8'))).toEqual({
		other: 1,
		mcpServers: { kept: { command: 'x' } },
	})
	expect((await invoke('add', '-s', 'local', 'x', '--', 'node')).code).toBe(64)
})

it('takes the transport, scope, env and header flags in either place', async () => {
	const { home, invoke } = setup()
	expect(
		(
			await invoke(
				'add',
				'-t',
				'http',
				'remote',
				'https://example.test/mcp',
				'-H',
				'X-Api-Key: ${KEY}',
			)
		).code,
	).toBe(0)
	expect(
		(await invoke('add', '-t', 'stdio', '-e', 'MODE=fast', 'local', '--', 'node', 'run.js')).code,
	).toBe(0)
	expect((await invoke('add', '-t', 'sse', 'old', 'https://example.test/sse')).code).toBe(64)
	expect(loadConfig({ cwd: tmpdir(), env: { NAMZU_HOME: home } }).mcpServers).toMatchObject({
		remote: { url: 'https://example.test/mcp', headers: { 'X-Api-Key': '${KEY}' } },
		local: { command: 'node', args: ['run.js'], env: { MODE: 'fast' } },
	})
})

it('prints one line for a retired --env or --header spelling and changes nothing', async () => {
	const { home, invoke } = setup()
	const env = await invoke('add', 'files', '--env', 'FILE_TOKEN', '--', 'node')
	expect(env.code).toBe(64)
	expect(env.stderr.trim().split('\n')).toHaveLength(1)
	expect(env.stderr).toContain('--env NAME=')
	const header = await invoke(
		'add',
		'search',
		'--url',
		'https://example.test/mcp',
		'--header',
		'Authorization=Bearer ${T}',
	)
	expect(header.code).toBe(64)
	expect(header.stderr.trim().split('\n')).toHaveLength(1)
	expect(header.stderr).toContain("--header 'NAME: VALUE'")
	expect(existsSync(join(home, 'config.yaml'))).toBe(false)
})
