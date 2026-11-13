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
			hooks: [],
		})
	})

	it('grants nothing from a file that is missing, broken or not an object', () => {
		expect(readFolderGrants(folder({}))).toEqual({
			allowRules: [],
			directories: [],
			toolServers: [],
			hooks: [],
		})
		expect(readFolderGrants(folder({ 'namzu.config.json': '{ nope' }))).toEqual({
			allowRules: [],
			directories: [],
			toolServers: [],
			hooks: [],
		})
		expect(readFolderGrants(folder({ 'namzu.config.json': '[1]' }))).toEqual({
			allowRules: [],
			directories: [],
			toolServers: [],
			hooks: [],
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

	it('lists the hooks the folder’s files declare, with what each would run', () => {
		const root = folder({
			'namzu.config.json': JSON.stringify({
				hooks: {
					pre_tool_use: [
						{ command: 'node', args: ['guard.mjs', '--strict'], matcher: 'bash' },
						{ command: './lint.sh' },
					],
					turn_end: [
						{ type: 'http', url: 'https://user:pw@hooks.example/notify?token=abc' },
						{ type: 'prompt', prompt: 'Is the work done?' },
					],
				},
			}),
			'namzu.config.local.json': JSON.stringify({
				hooks: { session_start: [{ command: 'echo hi' }] },
			}),
		})
		expect(readFolderGrants(root).hooks).toEqual([
			{ event: 'pre_tool_use', runs: 'node guard.mjs --strict' },
			{ event: 'pre_tool_use', runs: './lint.sh' },
			{ event: 'turn_end', runs: 'POST https://hooks.example/notify' },
			{ event: 'turn_end', runs: 'asks the model: Is the work done?' },
			{ event: 'session_start', runs: 'echo hi' },
		])
	})

	it('bounds a very long hook command', () => {
		const root = folder({
			'namzu.config.json': JSON.stringify({
				hooks: { turn_end: [{ command: `echo ${'x'.repeat(500)}` }] },
			}),
		})
		const [hook] = readFolderGrants(root).hooks
		expect(hook?.runs.length).toBeLessThanOrEqual(201)
		expect(hook?.runs.endsWith('…')).toBe(true)
	})
})

describe('what a folder’s own skills run', () => {
	const skillFile = (hooks: string) => `---\nname: pguard\ndescription: d\n${hooks}\n---\nBody.`

	function folderWithSkill(hooks: string): string {
		const root = folder({})
		mkdirSync(join(root, '.namzu', 'skills', 'pguard'), { recursive: true })
		writeFileSync(join(root, '.namzu', 'skills', 'pguard', 'SKILL.md'), skillFile(hooks))
		return root
	}

	it('lists the hooks a project skill carries beside the config’s own, named by the skill', () => {
		const root = folderWithSkill(
			[
				'hooks:',
				'  PreToolUse:',
				'    - matcher: Bash',
				'      hooks:',
				'        - command: node',
				'          args: ["${NAMZU_SKILL_ROOT}/guard.mjs"]',
			].join('\n'),
		)
		expect(readFolderGrants(root).hooks).toEqual([
			{ event: 'pre_tool_use (skill pguard)', runs: 'node ${NAMZU_SKILL_ROOT}/guard.mjs' },
		])
	})

	it('says a skill’s hooks that cannot be loaded will not run and will not pre-approve its tools', () => {
		const root = folderWithSkill(
			['hooks:', '  PreToolUse:', '    - hooks:', '        - args: ["a"]'].join('\n'),
		)
		expect(readFolderGrants(root).hooks).toEqual([
			{
				event: 'skill pguard',
				runs: 'hooks that cannot be loaded; it will not run them or pre-approve its tools',
			},
		])
	})
})
