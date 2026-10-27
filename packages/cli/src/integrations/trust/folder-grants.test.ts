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
		expect(readFolderGrants(root).toolServers).toEqual(['tickets', 'docs'])
	})

	it('keeps the cap the trust screen shows', () => {
		expect(MAX_SHOWN_GRANT_RULES).toBe(8)
	})
})
