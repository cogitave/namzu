import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { approveProjectMcpServers } from '../integrations/mcp/project-approval.js'
import {
	McpServerFileError,
	mergeLaunchMcpServers,
	parseMcpServerFile,
} from '../integrations/mcp/shared-file.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import {
	ConfigLoadError,
	loadBootstrapConfigWithProvenance,
	loadConfigWithProvenance,
	pendingProjectMcpServers,
} from './load.js'

/** The person's answer for every server in the folder's file. */
function approveAll(home: string, cwd: string): void {
	const declared = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8')).mcpServers
	const servers = Object.fromEntries(
		Object.entries(declared).map(([name, entry]) => {
			const { type: _type, ...rest } = entry as Record<string, unknown>
			return [name, rest]
		}),
	)
	approveProjectMcpServers(resolveNamzuHome({ home, env: {} }), cwd, servers)
}

function folder(files: Record<string, string>): { home: string; cwd: string } {
	const home = mkdtempSync(join(tmpdir(), 'namzu-mcpjson-home-'))
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-mcpjson-proj-'))
	for (const [name, body] of Object.entries(files)) writeFileSync(join(cwd, name), body)
	return { home, cwd }
}

const SHARED = JSON.stringify({
	mcpServers: {
		tickets: { type: 'stdio', command: 'node', args: ['tickets.js'] },
		search: { type: 'http', url: 'https://search.example.com/mcp' },
	},
})

describe('.mcp.json', () => {
	it('adds the servers it declares, without the type key other tools write', () => {
		const { home, cwd } = folder({ '.mcp.json': SHARED })
		approveAll(home, cwd)
		const { config, provenance } = loadConfigWithProvenance({ home, cwd, env: {} })
		expect(config.mcpServers).toEqual({
			tickets: { command: 'node', args: ['tickets.js'] },
			search: { url: 'https://search.example.com/mcp' },
		})
		expect(provenance.mcpServers).toEqual({
			kind: 'project-file',
			path: join(cwd, '.mcp.json'),
		})
	})

	it('starts nothing from a trusted folder until the person approves the server', () => {
		const { home, cwd } = folder({ '.mcp.json': SHARED })
		expect(loadConfigWithProvenance({ home, cwd, env: {} }).config.mcpServers).toBeUndefined()
		expect(pendingProjectMcpServers({ home, cwd, env: {} }).pending).toEqual(['tickets', 'search'])
	})

	it('starts only the servers that were approved', () => {
		const { home, cwd } = folder({ '.mcp.json': SHARED })
		const declared = pendingProjectMcpServers({ home, cwd, env: {} }).declared
		approveProjectMcpServers(resolveNamzuHome({ home, env: {} }), cwd, declared, ['search'])
		const { config } = loadConfigWithProvenance({ home, cwd, env: {} })
		expect(Object.keys(config.mcpServers ?? {})).toEqual(['search'])
	})

	it('asks again when an approved server changes', () => {
		const { home, cwd } = folder({ '.mcp.json': SHARED })
		approveAll(home, cwd)
		writeFileSync(
			join(cwd, '.mcp.json'),
			JSON.stringify({ mcpServers: { tickets: { command: 'sh', args: ['-c', 'other'] } } }),
		)
		expect(loadConfigWithProvenance({ home, cwd, env: {} }).config.mcpServers).toBeUndefined()
		expect(pendingProjectMcpServers({ home, cwd, env: {} }).pending).toEqual(['tickets'])
	})

	it('is not read before the folder is trusted', () => {
		const { home, cwd } = folder({ '.mcp.json': SHARED })
		const { config } = loadBootstrapConfigWithProvenance({ home, cwd, env: {} })
		expect(config.mcpServers).toBeUndefined()
	})

	it('keeps the project config entry when both name a server, and adds the rest', () => {
		const { home, cwd } = folder({
			'.mcp.json': SHARED,
			'namzu.config.json': JSON.stringify({
				mcpServers: { tickets: { command: 'python', args: ['t.py'] } },
			}),
		})
		approveAll(home, cwd)
		const { config } = loadConfigWithProvenance({ home, cwd, env: {} })
		expect(config.mcpServers).toEqual({
			tickets: { command: 'python', args: ['t.py'] },
			search: { url: 'https://search.example.com/mcp' },
		})
	})

	it('names the file when it is not valid JSON', () => {
		const { home, cwd } = folder({ '.mcp.json': '{ nope' })
		expect(() => loadConfigWithProvenance({ home, cwd, env: {} })).toThrow(ConfigLoadError)
		expect(() => loadConfigWithProvenance({ home, cwd, env: {} })).toThrow(/\.mcp\.json/)
	})

	it('is simply absent in most folders', () => {
		const { home, cwd } = folder({})
		expect(loadConfigWithProvenance({ home, cwd, env: {} }).config.mcpServers).toBeUndefined()
	})
})

describe('parseMcpServerFile', () => {
	it('refuses a server that is not an object, by name', () => {
		expect(() => parseMcpServerFile('{"mcpServers":{"a":3}}', 'f.json')).toThrow(
			/server "a" must be an object/,
		)
	})
	it('treats a file with no table as no servers', () => {
		expect(parseMcpServerFile('{}', 'f.json')).toEqual({})
	})
})

describe('--mcp-config files', () => {
	it('adds each file in order, later files and files over config winning by name', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-mcpcfg-'))
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'a.json'), '{"mcpServers":{"x":{"command":"a"},"y":{"command":"a"}}}')
		writeFileSync(join(dir, 'b.json'), '{"mcpServers":{"y":{"command":"b"}}}')
		const merged = mergeLaunchMcpServers(
			{ x: { command: 'config' }, z: { command: 'config' } },
			['a.json', 'b.json'],
			(file) => join(dir, file),
		)
		expect(merged).toEqual({
			x: { command: 'a' },
			y: { command: 'b' },
			z: { command: 'config' },
		})
	})

	it('names a file that is not there', () => {
		expect(() =>
			mergeLaunchMcpServers(undefined, ['gone.json'], (file) => join(tmpdir(), 'no-such', file)),
		).toThrow(McpServerFileError)
	})

	it('leaves the config alone when no file is named', () => {
		const configured = { x: { command: 'c' } }
		expect(mergeLaunchMcpServers(configured, [], (f) => f)).toBe(configured)
	})
})
