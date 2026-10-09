import { describe, expect, it } from 'vitest'
import type { ProjectView } from '../shared/protocol.js'
import {
	type BroadFolderEnv,
	FolderAccess,
	FolderAccessTokens,
	classifyBroadFolder,
} from './folder-access.js'

const windows: BroadFolderEnv = {
	platform: 'win32',
	home: 'C:\\Users\\arda',
	env: {
		WINDIR: 'C:\\Windows',
		ProgramFiles: 'C:\\Program Files',
		APPDATA: 'C:\\Users\\arda\\AppData\\Roaming',
		SystemDrive: 'C:',
	},
}
const linux: BroadFolderEnv = { platform: 'linux', home: '/home/arda', env: {} }

describe('classifyBroadFolder canonical bases', () => {
	it('compares against the resolved home, so a linked home is still broad', () => {
		const linked: BroadFolderEnv = { platform: 'linux', home: '/home/arda', env: {} }
		const resolve = (path: string) => (path === '/home/arda' ? '/data/arda' : path)
		expect(classifyBroadFolder('/data/arda', linked, resolve)).toBe('home')
		expect(classifyBroadFolder('/data/arda/project', linked, resolve)).toBeUndefined()
	})
	it('treats a WSL drive mount as a drive root', () => {
		expect(classifyBroadFolder('/mnt/c', linux)).toBe('drive')
		expect(classifyBroadFolder('/mnt/c/', linux)).toBe('drive')
		expect(classifyBroadFolder('/mnt/c/work', linux)).toBeUndefined()
	})
})

describe('classifyBroadFolder', () => {
	it.each([
		['C:\\', windows, 'drive'],
		['d:\\', windows, 'drive'],
		['C:\\Users\\arda', windows, 'home'],
		['c:\\users\\ARDA\\', windows, 'home'],
		['C:\\Windows', windows, 'system'],
		['C:\\Windows\\System32', windows, 'system'],
		['C:\\Program Files\\App', windows, 'system'],
		['C:\\Users\\arda\\AppData\\Roaming', windows, 'system'],
		['/', linux, 'drive'],
		['/home/arda', linux, 'home'],
		['/etc', linux, 'system'],
		['/usr/local/lib', linux, 'system'],
	] as const)('%s is broad (%s)', (path, env, kind) => {
		expect(classifyBroadFolder(path, env)).toBe(kind)
	})
	it.each([
		['C:\\work\\fixture', windows],
		['C:\\Users\\arda\\code\\app', windows],
		['C:\\Users\\arda\\AppData\\Roaming\\Code', windows],
		['D:\\Windows', windows],
		['C:\\WindowsApps', windows],
		['/home/arda/code/app', linux],
		['/srv/project', linux],
		['/etcetera', linux],
	] as const)('%s is an ordinary folder', (path, env) => {
		expect(classifyBroadFolder(path, env)).toBeUndefined()
	})
})

describe('FolderAccessTokens', () => {
	const make = () => {
		let now = 1000
		let n = 0
		const tokens = new FolderAccessTokens(
			() => now,
			() => `t${++n}`,
			60_000,
		)
		return {
			tokens,
			advance: (ms: number) => {
				now += ms
			},
		}
	}
	it('redeems once for the same window and path', () => {
		const { tokens } = make()
		const token = tokens.issue('w1', '/a')
		expect(tokens.redeem(token, 'w1', '/a')).toBe(true)
		expect(tokens.redeem(token, 'w1', '/a')).toBe(false)
	})
	it('refuses another window or path, and spends the token doing so', () => {
		const { tokens } = make()
		const first = tokens.issue('w1', '/a')
		expect(tokens.redeem(first, 'w2', '/a')).toBe(false)
		expect(tokens.redeem(first, 'w1', '/a')).toBe(false)
		const second = tokens.issue('w1', '/a')
		expect(tokens.redeem(second, 'w1', '/b')).toBe(false)
		expect(tokens.redeem(second, 'w1', '/a')).toBe(false)
	})
	it('refuses an expired token', () => {
		const { tokens, advance } = make()
		const token = tokens.issue('w1', '/a')
		advance(60_001)
		expect(tokens.redeem(token, 'w1', '/a')).toBe(false)
	})
	it('refuses unknown and non-string tokens', () => {
		const { tokens } = make()
		expect(tokens.redeem('nope', 'w1', '/a')).toBe(false)
		expect(tokens.redeem(undefined, 'w1', '/a')).toBe(false)
		expect(tokens.redeem({}, 'w1', '/a')).toBe(false)
	})
})

describe('FolderAccess', () => {
	const setup = (env = windows) => {
		const known = new Map<string, ProjectView>()
		const trusted: string[] = []
		let now = 0
		let n = 0
		const access = new FolderAccess({
			env,
			canonical: (path) => path,
			tokens: new FolderAccessTokens(
				() => now,
				() => `tok${++n}`,
				5 * 60_000,
			),
			openProject: async (path) => {
				const view: ProjectView = {
					id: `p${known.size}`,
					path,
					name: path,
					trusted: false,
					status: 'ready',
				}
				known.set(view.id, view)
				return { ...view }
			},
			findProject: (id) => known.get(id),
			trust: async (id) => {
				trusted.push(id)
				const view = known.get(id) as ProjectView
				view.trusted = true
				return { ...view }
			},
		})
		return {
			access,
			known,
			trusted,
			advance: (ms: number) => {
				now += ms
			},
		}
	}
	it('trusts an ordinary pick at once with no token', async () => {
		const { access, trusted } = setup()
		const project = await access.picked('w1', 'C:\\work\\fixture')
		expect(project.trusted).toBe(true)
		expect(project.broadFolder).toBeUndefined()
		expect(trusted).toEqual(['p0'])
	})
	it('holds a broad pick outside the app until its token is redeemed', async () => {
		const { access, known, trusted } = setup()
		const pending = await access.picked('w1', 'C:\\')
		expect(pending).toMatchObject({
			id: 'pending-folder',
			pending: true,
			trusted: false,
			broadFolder: { kind: 'drive', token: 'tok1' },
		})
		// Nothing joined the app: no row to show behind the dialog, nothing to clean up on cancel.
		expect(known.size).toBe(0)
		expect(trusted).toEqual([])
		const done = await access.admit('w1', pending.broadFolder?.token)
		expect(done.trusted).toBe(true)
		expect(trusted).toEqual(['p0'])
	})
	it('refuses reuse, another window and expiry of a broad pick, and adds nothing', async () => {
		const { access, known, trusted, advance } = setup()
		const home = await access.picked('w1', 'C:\\Users\\arda')
		const token = home.broadFolder?.token
		await expect(access.admit('w2', token)).rejects.toThrow(/expired/)
		await expect(access.admit('w1', token)).rejects.toThrow(/expired/)
		const again = await access.picked('w1', 'C:\\Users\\arda')
		advance(5 * 60_000 + 1)
		await expect(access.admit('w1', again.broadFolder?.token)).rejects.toThrow(/expired/)
		expect(known.size).toBe(0)
		expect(trusted).toEqual([])
	})
	it('never gives an ordinary folder a token flow', async () => {
		const { access, known, trusted } = setup()
		const project = await access.picked('w1', 'C:\\work\\fixture')
		await expect(access.confirm('w1', project.id, 'anything')).resolves.toMatchObject({
			trusted: true,
		})
		expect(trusted).toEqual(['p0'])
		expect(known.get('p0')?.broadFolder).toBeUndefined()
	})
	it('lets the in-app dialog trust a known ordinary folder, but a known broad one only through a token', async () => {
		const { access, known, trusted } = setup(linux)
		known.set('k1', { id: 'k1', path: '/srv/app', name: 'app', trusted: false, status: 'ready' })
		known.set('k2', { id: 'k2', path: '/home/arda', name: 'arda', trusted: false, status: 'ready' })
		expect((await access.confirm('w1', 'k1')).trusted).toBe(true)
		const broad = await access.confirm('w1', 'k2')
		expect(broad.trusted).toBe(false)
		expect(broad.broadFolder?.kind).toBe('home')
		expect(trusted).toEqual(['k1'])
		expect((await access.confirm('w1', 'k2', broad.broadFolder?.token)).trusted).toBe(true)
	})
	it('rejects an unknown project', async () => {
		await expect(setup().access.confirm('w1', 'nope')).rejects.toThrow(/Unknown project/)
	})
})

describe('FolderAccess for a folder whose settings changed', () => {
	it("shows the detailed dialog for a changed folder and trusts only with main's token, and refuses a broad folder", async () => {
		const trusted: string[] = []
		const views = new Map<string, ProjectView>([
			[
				'a',
				{
					id: 'a',
					path: '/work/a',
					name: 'a',
					trusted: false,
					status: 'ready',
					settingsChanged: ['hooks changed'],
				},
			],
			[
				'b',
				{
					id: 'b',
					path: '/home/arda',
					name: 'b',
					trusted: false,
					status: 'ready',
					settingsChanged: ['hooks changed'],
				},
			],
		])
		const access = new FolderAccess({
			env: linux,
			canonical: (path) => path,
			openProject: async () => {
				throw new Error('unused')
			},
			findProject: (id) => views.get(id),
			trust: async (id) => {
				trusted.push(id)
				return { ...(views.get(id) as ProjectView), trusted: true }
			},
			findSettings: async () => [{ label: 'hooks', lines: ['pre tool use: ./check.sh'] }],
		})
		const asked = await access.confirm('w', 'a')
		expect(asked.trusted).toBe(false)
		expect(asked.riskySettings?.found).toEqual(['hooks changed', 'hooks'])
		expect(asked.riskySettings?.details).toEqual([
			{ label: 'hooks', lines: ['pre tool use: ./check.sh'] },
		])
		expect(trusted).toEqual([])
		expect((await access.confirm('w', 'a', asked.riskySettings?.token)).trusted).toBe(true)
		expect((await access.confirm('w', 'b')).broadFolder?.kind).toBe('home')
		expect(trusted).toEqual(['a'])
	})
})
