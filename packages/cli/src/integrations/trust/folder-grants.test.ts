import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MAX_SHOWN_GRANT_RULES, readFolderGrants } from './folder-grants.js'

const roots: string[] = []
function folder(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-grants-'))
	roots.push(root)
	mkdirSync(root, { recursive: true })
	for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
	return root
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('what a folder pre-approves', () => {
	it('lists allow rules and added directories from both project files, each once', () => {
		const root = folder({
			'namzu.config.json': JSON.stringify({
				permissions: {
					read: 'allow',
					bash: { 'git status *': 'allow', 'rm *': 'deny' },
					edit: 'ask',
				},
				additionalDirectories: ['../shared'],
			}),
			'namzu.config.local.json': JSON.stringify({
				permissions: { read: 'allow', web_fetch: 'allow' },
				additionalDirectories: ['../shared', '/data'],
			}),
		})
		expect(readFolderGrants(root)).toEqual({
			allowRules: ['read', 'bash(git status *)', 'web_fetch'],
			directories: ['../shared', '/data'],
			toolServers: [],
		})
	})

	it('grants nothing from a file that is missing, broken or not an object', () => {
		expect(readFolderGrants(folder({}))).toEqual({
			allowRules: [],
			directories: [],
			toolServers: [],
		})
		expect(readFolderGrants(folder({ 'namzu.config.json': '{ nope' }))).toEqual({
			allowRules: [],
			directories: [],
			toolServers: [],
		})
		expect(readFolderGrants(folder({ 'namzu.config.json': '[1]' }))).toEqual({
			allowRules: [],
			directories: [],
			toolServers: [],
		})
	})

	it('lists the tool servers the shared file declares', () => {
		const root = folder({
			'.mcp.json': JSON.stringify({
				mcpServers: { tickets: { command: 'node' }, docs: { url: 'https://d.example/mcp' } },
			}),
		})
		const servers = readFolderGrants(root).toolServers
		expect(servers.map((server) => server.name)).toEqual(['tickets', 'docs'])
		expect(servers.map((server) => server.runs)).toEqual(['node', 'https://d.example/mcp'])
	})

	it('shows what each server runs, without environment values, headers or a token in the address', () => {
		const root = folder({
			'.mcp.json': JSON.stringify({
				mcpServers: {
					local: {
						command: 'npx',
						args: ['-y', 'some-server', '--flag'],
						env: { API_KEY: 'secret-value' },
					},
					remote: {
						url: 'https://user:pw@tools.example/mcp/v1?token=abc',
						headers: { Authorization: 'Bearer secret-value' },
					},
				},
			}),
		})
		const shown = readFolderGrants(root).toolServers
		expect(shown.map((server) => server.runs)).toEqual([
			'npx -y some-server --flag',
			'https://tools.example/mcp/v1',
		])
		expect(JSON.stringify(shown)).not.toContain('secret-value')
		expect(JSON.stringify(shown)).not.toContain('token=abc')
	})

	it('keeps the cap the trust screen shows', () => {
		expect(MAX_SHOWN_GRANT_RULES).toBe(8)
	})
})
