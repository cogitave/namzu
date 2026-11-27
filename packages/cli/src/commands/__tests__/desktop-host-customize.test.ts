import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { createPal } from '../../pals/store.js'
import { decideHeadlessTrust } from '../../permissions/headless-trust.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'
import { createDesktopHostExtensions } from '../desktop-host.js'

let root: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-desktop-host-customize-'))
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

function runtime(extra: Partial<AcpRuntimeDependencies> = {}) {
	return createCliAcpRuntime(
		{
			config: {},
			formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} },
		},
		{
			decideTrust: decideHeadlessTrust,
			resolveSession: async (sessionId: string) => ({ sessionId }),
			...extra,
		} as unknown as AcpRuntimeDependencies,
	)
}

type Catalog = {
	skills: {
		name: string
		description: string
		tier: string
		place: string
		plugin?: string
		state: string
		updatedAt?: string
		fileCount: number
		uses7d?: number
		lastUsedAt?: string
		uses?: number
		removable: boolean
	}[]
}

function skill(dir: string, name: string, description = 'x', extra: Record<string, string> = {}) {
	const folder = join(dir, name)
	mkdirSync(folder, { recursive: true })
	writeFileSync(
		join(folder, 'SKILL.md'),
		`---\nname: ${name}\ndescription: ${description}\n---\nBody.`,
	)
	for (const [file, body] of Object.entries(extra)) {
		mkdirSync(join(folder, file, '..'), { recursive: true })
		writeFileSync(join(folder, file), body)
	}
	return folder
}

async function withHost<T>(
	run: (host: ReturnType<typeof createDesktopHostExtensions>) => Promise<T>,
	extra: Partial<AcpRuntimeDependencies> = {},
) {
	const owner = runtime(extra)
	const host = createDesktopHostExtensions(owner, cwd)
	try {
		return await run(host)
	} finally {
		await owner.close()
	}
}

it('catalogues skills with place, state, time, files and use, the project’s only once trusted', async () => {
	skill(join(cwd, '.namzu', 'skills'), 'proj-skill', 'a'.repeat(2000), {
		'notes/a.md': 'a',
		'.git/config': 'hidden',
	})
	skill(join(root, 'state', 'skills'), 'mine', 'my skill')
	writeFileSync(
		join(root, 'state', 'skill-usage.json'),
		JSON.stringify({
			v: 1,
			since: 1,
			skills: {
				mine: {
					count: 5,
					lastUsedAt: Date.now() - 1000,
					loads: [{ at: Date.now() - 1000, tokens: 3 }],
				},
			},
		}),
	)
	await withHost(async (host) => {
		const before = (await host['namzu/skills/catalog']({})) as unknown as Catalog
		expect(before.skills.map((s) => s.name)).not.toContain('proj-skill')
		const mine = before.skills.find((s) => s.name === 'mine')
		expect(mine).toMatchObject({
			tier: 'user',
			place: 'user',
			state: 'on',
			fileCount: 1,
			uses: 5,
			uses7d: 1,
			removable: true,
		})
		expect(mine?.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
		expect(mine?.lastUsedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
		expect(before.skills.some((s) => s.tier === 'system' && !s.removable)).toBe(true)
		host['namzu/project/trust']({ confirmed: true, cwd })
		const after = (await host['namzu/skills/catalog']({})) as unknown as Catalog
		const proj = after.skills.find((s) => s.name === 'proj-skill')
		expect(proj?.description).toHaveLength(1024)
		expect(proj).toMatchObject({ tier: 'project', place: 'project', fileCount: 2, removable: true })
		await expect(host['namzu/skills/catalog']({ cwd: '/x' })).rejects.toThrow(
			'Invalid skills request.',
		)
	})
})

it('reports the state the settings give a skill, the same one the terminal screen shows', async () => {
	skill(join(root, 'state', 'skills'), 'quiet')
	skill(join(root, 'state', 'skills'), 'gone')
	writeFileSync(
		join(root, 'state', 'config.yaml'),
		'skills:\n  disabled: [gone]\n  overrides:\n    quiet: name-only\n',
	)
	await withHost(async (host) => {
		host['namzu/project/trust']({ confirmed: true, cwd })
		const view = (await host['namzu/skills/catalog']({})) as unknown as Catalog
		expect(view.skills.find((s) => s.name === 'quiet')?.state).toBe('name-only')
		expect(view.skills.find((s) => s.name === 'gone')?.state).toBe('off')
	})
})

it('lists a skill folder’s files, skipping dot-folders and links that leave it, at most 200', async () => {
	const folder = skill(join(root, 'state', 'skills'), 'filed', 'x', {
		'a.md': 'a',
		'sub/b.txt': 'bb',
		'.git/config': 'no',
	})
	writeFileSync(join(root, 'outside.txt'), 'secret')
	symlinkSync(join(root, 'outside.txt'), join(folder, 'leak.txt'))
	symlinkSync(root, join(folder, 'linked-dir'))
	for (let i = 0; i < 250; i++)
		writeFileSync(join(folder, `f${String(i).padStart(3, '0')}.txt`), 'x')
	await withHost(async (host) => {
		const { files } = (await host['namzu/skills/files']({ name: 'filed' })) as unknown as {
			files: { path: string; size: number }[]
		}
		expect(files).toHaveLength(200)
		const paths = files.map((f) => f.path)
		expect(paths).not.toContain('leak.txt')
		expect(paths.some((p) => p.startsWith('.git') || p.startsWith('linked-dir'))).toBe(false)
		expect(paths).toContain('SKILL.md')
		expect(paths).toContain('a.md')
		await expect(host['namzu/skills/files']({ name: 'nope' })).rejects.toThrow('No skill')
		await expect(host['namzu/skills/files']({ name: 'filed', extra: 1 })).rejects.toThrow('Invalid')
	})
})

it('reads a text file of a skill, cuts it at 256 KiB and refuses binary files', async () => {
	const folder = skill(join(root, 'state', 'skills'), 'reader', 'x', {
		'doc/one.md': '# One',
		'big.txt': 'x'.repeat(300 * 1024),
	})
	writeFileSync(join(folder, 'bin.dat'), Buffer.from([65, 0, 66]))
	await withHost(async (host) => {
		expect(await host['namzu/skills/read_file']({ name: 'reader', path: 'doc/one.md' })).toEqual({
			text: '# One',
			truncated: false,
		})
		const big = (await host['namzu/skills/read_file']({
			name: 'reader',
			path: 'big.txt',
		})) as unknown as {
			text: string
			truncated: boolean
		}
		expect(big.text).toHaveLength(256 * 1024)
		expect(big.truncated).toBe(true)
		await expect(
			host['namzu/skills/read_file']({ name: 'reader', path: 'bin.dat' }),
		).rejects.toThrow('not text')
	})
})

it('refuses a path that leaves the skill folder: dots, absolute, drive, NUL, a link out', async () => {
	const folder = skill(join(root, 'state', 'skills'), 'guarded', 'x', { '.hidden/x.txt': 'h' })
	writeFileSync(join(root, 'outside.txt'), 'secret')
	symlinkSync(join(root, 'outside.txt'), join(folder, 'leak.txt'))
	symlinkSync(root, join(folder, 'up'))
	await withHost(async (host) => {
		for (const path of [
			'../outside.txt',
			'../../x',
			'a/../../outside.txt',
			join(root, 'outside.txt'),
			'/etc/passwd',
			'C:\\Windows\\win.ini',
			'\\\\host\\share',
			'a\0b',
			'leak.txt',
			'up/outside.txt',
			'.hidden/x.txt',
			'missing.txt',
			'',
		]) {
			await expect(
				host['namzu/skills/read_file']({ name: 'guarded', path }),
				JSON.stringify(path),
			).rejects.toThrow()
		}
		await expect(
			host['namzu/skills/read_file']({ name: 'guarded', path: 'x'.repeat(513) }),
		).rejects.toThrow()
		await expect(host['namzu/skills/read_file']({ name: 'guarded' })).rejects.toThrow()
		await expect(
			host['namzu/skills/read_file']({ name: 'guarded', path: 'SKILL.md', extra: 1 }),
		).rejects.toThrow('Invalid skill file request.')
	})
})

it('adds the manifest’s skills, servers, author and time to the plugin list without running anything', async () => {
	const plugin = join(cwd, '.namzu', 'plugins', 'demo')
	mkdirSync(plugin, { recursive: true })
	skill(join(plugin, 'skills'), 'helper', 'helps')
	writeFileSync(
		join(plugin, 'plugin.json'),
		JSON.stringify({
			name: 'demo',
			version: '1.2.3',
			description: 'A demo.',
			author: 'Someone',
			skills: ['skills/helper', 'skills/missing'],
			mcpServers: [{ name: 'notes', command: 'node' }],
		}),
	)
	const resolveProjectContext = (() => ({
		config: { plugins: { enabled: true } },
	})) as unknown as AcpRuntimeDependencies['resolveProjectContext']
	await withHost(
		async (host) => {
			host['namzu/project/trust']({ confirmed: true, cwd })
			const view = (await host['namzu/plugins/list']({})) as unknown as {
				plugins: Record<string, unknown>[]
			}
			const entry = view.plugins.find((p) => p.name === 'demo')
			expect(entry).toMatchObject({
				version: '1.2.3',
				description: 'A demo.',
				scope: 'project',
				author: 'Someone',
				servers: [{ name: 'notes' }],
				skills: [{ name: 'demo__helper', description: 'helps' }],
			})
			expect(entry?.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
			const catalog = (await host['namzu/skills/catalog']({})) as unknown as Catalog
			expect(catalog.skills.find((s) => s.name === 'demo__helper')).toMatchObject({
				plugin: 'demo',
				place: 'plugin',
				removable: false,
			})
		},
		{ resolveProjectContext },
	)
})

it('is refused for a Pal, which reads no host skills', async () => {
	const pal = createPal({ name: 'Customize fixture' })
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, pal.workspace)
	try {
		await expect(host['namzu/skills/catalog']({})).rejects.toThrow('Pals')
		await expect(host['namzu/skills/files']({ name: 'x' })).rejects.toThrow('Pals')
		await expect(host['namzu/skills/read_file']({ name: 'x', path: 'a' })).rejects.toThrow('Pals')
	} finally {
		await owner.close()
	}
})
