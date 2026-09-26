import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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

it('adds command and HTTP servers, redacts secrets, and removes only the named user entry', async () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-mcp-command-'))
	roots.push(home)
	vi.stubEnv('NAMZU_HOME', home)
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
	const invoke = async (...args: string[]) => {
		stdout = ''
		stderr = ''
		const code = await runCli({ argv: ['node', 'namzu', '--format', 'json', 'mcp', ...args] })
		return {
			code,
			output: stdout ? (JSON.parse(stdout) as Record<string, unknown>) : null,
			stderr,
		}
	}
	const command = await invoke(
		'add',
		'files',
		'--env',
		'FILE_TOKEN',
		'--',
		'node',
		'server.js',
		'--secret',
		'do-not-print',
	)
	expect(command.code).toBe(0)
	const url = await invoke(
		'add',
		'search',
		'--url',
		'https://example.test/mcp?token=do-not-print',
		'--header',
		'Authorization=Bearer ${SEARCH_TOKEN}',
	)
	expect(url.code).toBe(0)
	const file = join(home, 'config.yaml')
	expect(statSync(file).mode & 0o777).toBe(0o600)
	expect(loadConfig({ cwd: tmpdir(), env: { NAMZU_HOME: home } }).mcpServers).toMatchObject({
		files: {
			command: 'node',
			args: ['server.js', '--secret', 'do-not-print'],
			inheritEnv: ['FILE_TOKEN'],
		},
		search: {
			url: 'https://example.test/mcp?token=do-not-print',
			headers: { Authorization: 'Bearer ${SEARCH_TOKEN}' },
		},
	})
	const listed = await invoke('list')
	expect(listed.code).toBe(0)
	expect(listed.output?.servers).toMatchObject([
		{ name: 'files', transport: 'stdio', argumentCount: 3 },
		{ name: 'search', transport: 'http', endpoint: 'https://example.test/mcp' },
	])
	expect(JSON.stringify(listed.output)).not.toContain('do-not-print')
	expect(JSON.stringify(listed.output)).not.toContain('SEARCH_TOKEN')
	const detail = await invoke('get', 'search')
	expect(detail.code).toBe(0)
	expect(JSON.stringify(detail.output)).not.toContain('do-not-print')
	const removed = await invoke('remove', 'files')
	expect(removed.code).toBe(0)
	expect(loadConfig({ cwd: tmpdir(), env: { NAMZU_HOME: home } }).mcpServers).toMatchObject({
		search: { url: 'https://example.test/mcp?token=do-not-print' },
	})
	expect(readFileSync(file, 'utf8')).not.toContain('files:')
})

it('preserves unrelated YAML and refuses a literal secret, a duplicate, and broken config', async () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-mcp-command-'))
	roots.push(home)
	vi.stubEnv('NAMZU_HOME', home)
	writeFileSync(join(home, 'config.yaml'), '# keep this\nquiet: true\n')
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
	const invoke = async (...args: string[]) => {
		return runCli({ argv: ['node', 'namzu', 'mcp', ...args] })
	}
	expect(
		await invoke(
			'add',
			'search',
			'--url',
			'https://example.test/mcp',
			'--header',
			'Authorization=literal-secret',
		),
	).toBe(64)
	expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe('# keep this\nquiet: true\n')
	expect(await invoke('add', 'search', '--url', 'https://example.test/mcp')).toBe(0)
	expect(
		await invoke(
			'add',
			'insecure',
			'--url',
			'http://example.test/mcp',
			'--header',
			'Authorization=${SECRET_TOKEN}',
		),
	).toBe(64)
	expect(await invoke('add', 'insecure', '--url', 'http://example.test/mcp?token=secret')).toBe(64)
	expect(await invoke('add', 'search', '--url', 'https://other.test/mcp')).toBe(64)
	expect(await invoke('remove', 'missing')).toBe(64)
	const saved = readFileSync(join(home, 'config.yaml'), 'utf8')
	expect(saved).toContain('# keep this')
	expect(saved).toContain('quiet: true')
	writeFileSync(join(home, 'config.yaml'), 'mcpServers: [\n')
	expect(await invoke('list')).toBe(78)
	expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe('mcpServers: [\n')
})

it('gets and removes an existing server whose name predates the add-name policy', async () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-mcp-command-'))
	roots.push(home)
	vi.stubEnv('NAMZU_HOME', home)
	writeFileSync(
		join(home, 'config.yaml'),
		'mcpServers:\n  github.com:\n    command: node\n    args: [server.js]\n  regular:\n    command: node\n',
	)
	let stdout = ''
	vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		stdout += String(chunk)
		return true
	})
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
	const get = await runCli({
		argv: ['node', 'namzu', '--format', 'json', 'mcp', 'get', 'github.com'],
	})
	expect(get).toBe(0)
	expect(JSON.parse(stdout)).toMatchObject({
		server: { name: 'github.com', transport: 'stdio', command: 'node' },
	})
	expect(await runCli({ argv: ['node', 'namzu', 'mcp', 'remove', 'github.com'] })).toBe(0)
	const saved = readFileSync(join(home, 'config.yaml'), 'utf8')
	expect(saved).not.toContain('github.com:')
	expect(saved).toContain('regular:')
	expect(await runCli({ argv: ['node', 'namzu', 'mcp', 'add', 'github.com', '--', 'node'] })).toBe(
		64,
	)
})
