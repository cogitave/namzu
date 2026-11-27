import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { decideHeadlessTrust } from '../../permissions/headless-trust.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'
import { createDesktopHostExtensions } from '../desktop-host.js'

let root: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-desktop-host-lists-'))
	cwd = join(root, 'project')
	mkdirSync(join(cwd, '.git'), { recursive: true })
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

function runtime() {
	return createCliAcpRuntime(
		{
			config: {},
			formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} },
		},
		{
			decideTrust: decideHeadlessTrust,
			resolveSession: async (sessionId: string) => ({ sessionId }),
		} as unknown as AcpRuntimeDependencies,
	)
}
const userFile = () => join(root, 'state', 'config.yaml')
const userDoc = () => parse(readFileSync(userFile(), 'utf8')) as Record<string, unknown>
type Answer = { file: string; servers: { name: string; kind: string }[] }

it('lists the installed skills by name and tier, the project’s only once the folder is trusted', async () => {
	const skills = join(cwd, '.namzu', 'skills', 'local')
	mkdirSync(skills, { recursive: true })
	writeFileSync(join(skills, 'SKILL.md'), '---\nname: local-skill\ndescription: x\n---\nBody.')
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	try {
		const before = (await host['namzu/skills/list']({})) as unknown as {
			skills: { name: string }[]
		}
		expect(before.skills.map((s) => s.name)).not.toContain('local-skill')
		host['namzu/project/trust']({ confirmed: true, cwd })
		const after = (await host['namzu/skills/list']({})) as unknown as {
			skills: { name: string; tier: string; where: string }[]
		}
		expect(after.skills).toContainEqual({
			name: 'local-skill',
			tier: 'project',
			where: expect.any(String),
		})
		for (const skill of after.skills)
			expect(Object.keys(skill).sort()).toEqual(['name', 'tier', 'where'])
		await expect(host['namzu/skills/list']({ cwd: '/x' })).rejects.toThrow(
			'Invalid skills request.',
		)
	} finally {
		await owner.close()
	}
})

it('adds, checks, edits and removes a tool server in the user file, keeping variables out of sight', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	try {
		const added = (await host['namzu/mcp/save-user-server']({
			mode: 'add',
			name: 'notes',
			command: 'npx',
			args: ['-y', 'notes-mcp'],
		})) as Answer
		expect(added.file).toBe(userFile())
		expect(added.servers).toEqual([{ name: 'notes', kind: 'command', command: 'npx', argCount: 2 }])
		// The list carries no arguments; the entry is read whole by name.
		const whole = (await host['namzu/mcp/user-servers']({ name: 'notes' })) as Answer
		expect(whole.servers).toEqual([
			{ name: 'notes', kind: 'command', command: 'npx', args: ['-y', 'notes-mcp'] },
		])
		// A hand-written variable stays through an edit and never comes back in an answer.
		const text = readFileSync(userFile(), 'utf8')
		writeFileSync(userFile(), text.replace('notes:', 'notes:\n    env:\n      TOKEN: hidden-value'))
		const before = readFileSync(userFile(), 'utf8')
		await host['namzu/mcp/save-user-server']({
			mode: 'edit',
			name: 'notes',
			command: 'other',
			dryRun: true,
		})
		expect(readFileSync(userFile(), 'utf8')).toBe(before)
		const edited = await host['namzu/mcp/save-user-server']({
			mode: 'edit',
			name: 'notes',
			command: 'other',
		})
		expect(JSON.stringify(edited)).not.toContain('hidden-value')
		const servers = userDoc().mcpServers as Record<string, Record<string, unknown>>
		expect(servers.notes).toEqual({ command: 'other', env: { TOKEN: 'hidden-value' } })
		const listed = (await host['namzu/mcp/user-servers']({})) as Answer
		expect(listed.servers.map((s) => s.name)).toEqual(['notes'])
		const removed = (await host['namzu/mcp/remove-user-server']({ name: 'notes' })) as Answer
		expect(removed.servers).toEqual([])
	} finally {
		await owner.close()
	}
})

it('refuses what the engine refuses, with its words, and odd requests', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	try {
		await expect(
			host['namzu/mcp/save-user-server']({ mode: 'add', name: '9x', command: 'a' }),
		).rejects.toThrow('A server name starts with a letter')
		await expect(
			host['namzu/mcp/save-user-server']({ mode: 'add', name: 'a', url: 'ftp://e.com' }),
		).rejects.toThrow('The address must start with http or https.')
		await expect(
			host['namzu/mcp/save-user-server']({ mode: 'add', name: 'a', command: 'x', env: {} }),
		).rejects.toThrow('names only the server')
		await expect(
			host['namzu/mcp/save-user-server']({ mode: 'replace', name: 'a', command: 'x' }),
		).rejects.toThrow('add or to edit')
		await expect(
			host['namzu/mcp/save-user-server']({ mode: 'add', name: 'a', command: 'x', args: [1] }),
		).rejects.toThrow('list of words')
		await expect(host['namzu/mcp/remove-user-server']({ name: 'a', all: true })).rejects.toThrow(
			'names only the server',
		)
		await expect(host['namzu/mcp/user-servers']({ name: 5 })).rejects.toThrow(
			'Invalid tool servers request.',
		)
		await expect(host['namzu/mcp/user-servers']({ x: 1 })).rejects.toThrow(
			'Invalid tool servers request.',
		)
	} finally {
		await owner.close()
	}
})

it('answers which browser the engine would drive, from the user file, and refuses parameters', async () => {
	writeFileSync(userFile(), 'browser:\n  enabled: false\n')
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	try {
		expect(await host['namzu/browser/status']({})).toMatchObject({ enabled: false, state: 'off' })
		await expect(host['namzu/browser/status']({ cwd: '/x' })).rejects.toThrow(
			'Invalid browser status request.',
		)
	} finally {
		await owner.close()
	}
})

it('takes headers as environment references only, through the host', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	try {
		await host['namzu/mcp/save-user-server']({
			mode: 'add',
			name: 'remote',
			url: 'https://example.com/mcp',
			headers: { 'X-Api-Key': '${EXAMPLE_TOKEN}' },
		})
		const servers = userDoc().mcpServers as Record<string, Record<string, unknown>>
		expect(servers.remote?.headers).toEqual({ 'X-Api-Key': '${EXAMPLE_TOKEN}' })
		await expect(
			host['namzu/mcp/save-user-server']({
				mode: 'add',
				name: 'other',
				url: 'https://example.com/mcp',
				headers: { 'X-Api-Key': 'sk-live-abc' },
			}),
		).rejects.toThrow('environment reference')
		await expect(
			host['namzu/mcp/save-user-server']({
				mode: 'add',
				name: 'other',
				url: 'https://example.com/mcp',
				headers: ['x'],
			}),
		).rejects.toThrow('Headers are names')
		await expect(
			host['namzu/mcp/save-user-server']({
				mode: 'add',
				name: 'other',
				url: 'https://example.com/mcp',
				headers: { 'X-A': 5 },
			}),
		).rejects.toThrow('Headers are names')
		const text = readFileSync(userFile(), 'utf8')
		expect(text).not.toContain('sk-live-abc')
	} finally {
		await owner.close()
	}
})

it('stages a skill file through the real host wiring: an ordinary folder is not taken for a Pal', async () => {
	const file = join(root, 'notes.md')
	writeFileSync(file, '---\nname: notes\ndescription: Keep notes.\n---\nBody.')
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	try {
		const staged = (await host['namzu/skills/stage']({ paths: [file] })) as unknown as {
			items: { name?: string; error?: string }[]
		}
		expect(staged.items).toHaveLength(1)
		expect(staged.items[0]?.error).toBeUndefined()
		expect(staged.items[0]?.name).toBe('notes')
	} finally {
		await owner.close?.()
	}
})
