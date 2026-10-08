import { describe, expect, it } from 'vitest'
import type { ProjectView } from '../shared/protocol.js'
import {
	type BroadFolderEnv,
	FolderAccess,
	FolderAccessTokens,
	PENDING_FOLDER_ID,
} from './folder-access.js'

const linux: BroadFolderEnv = { platform: 'linux', home: '/home/arda', env: {} }

function setup(risky: Record<string, string[]>) {
	const known = new Map<string, ProjectView>()
	const opened: string[] = []
	const trusted: string[] = []
	let now = 0
	let n = 0
	const access = new FolderAccess({
		env: linux,
		canonical: (path) => path,
		findSettings: async (path) => risky[path] ?? [],
		tokens: new FolderAccessTokens(
			() => now,
			() => `tok${++n}`,
			5 * 60_000,
		),
		openProject: async (path) => {
			opened.push(path)
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
		opened,
		trusted,
		advance: (ms: number) => {
			now += ms
		},
	}
}

describe('FolderAccess with settings that run code', () => {
	it('keeps an ordinary pick trusted at once', async () => {
		const { access, trusted } = setup({})
		const project = await access.picked('w1', '/srv/plain')
		expect(project.trusted).toBe(true)
		expect(project.riskySettings).toBeUndefined()
		expect(trusted).toEqual(['p0'])
	})
	it('holds a risky pick outside the app: nothing opened, nothing trusted', async () => {
		const { access, opened, trusted } = setup({ '/srv/risky': ['hooks', '2 MCP servers'] })
		const pending = await access.picked('w1', '/srv/risky')
		expect(pending).toMatchObject({
			id: PENDING_FOLDER_ID,
			pending: true,
			trusted: false,
			name: 'risky',
			riskySettings: { found: ['hooks', '2 MCP servers'], token: 'tok1' },
		})
		expect(opened).toEqual([])
		expect(trusted).toEqual([])
	})
	it('adds and trusts the folder only when the token is redeemed, once', async () => {
		const { access, opened, trusted } = setup({ '/srv/risky': ['hooks'] })
		const pending = await access.picked('w1', '/srv/risky')
		const token = pending.riskySettings?.token
		const added = await access.admit('w1', token)
		expect(added.trusted).toBe(true)
		expect(opened).toEqual(['/srv/risky'])
		expect(trusted).toEqual(['p0'])
		await expect(access.admit('w1', token)).rejects.toThrow(/expired/)
		expect(opened).toEqual(['/srv/risky'])
	})
	it('refuses another window, a forged token and an expired token', async () => {
		const { access, opened, advance } = setup({ '/srv/risky': ['hooks'] })
		const first = await access.picked('w1', '/srv/risky')
		await expect(access.admit('w2', first.riskySettings?.token)).rejects.toThrow(/expired/)
		await expect(access.admit('w1', 'forged')).rejects.toThrow(/expired/)
		const second = await access.picked('w1', '/srv/risky')
		advance(5 * 60_000 + 1)
		await expect(access.admit('w1', second.riskySettings?.token)).rejects.toThrow(/expired/)
		expect(opened).toEqual([])
	})
	it('does not let a broad folder skip its own caution through the settings path', async () => {
		const { access } = setup({ '/etc': ['hooks'] })
		const project = await access.picked('w1', '/etc')
		expect(project.broadFolder).toMatchObject({ kind: 'system' })
		expect(project.riskySettings).toBeUndefined()
	})
	it('asks again for a known untrusted folder that holds such settings', async () => {
		const { access, known, trusted } = setup({ '/srv/known': ['plugins'] })
		known.set('k1', {
			id: 'k1',
			path: '/srv/known',
			name: 'known',
			trusted: false,
			status: 'ready',
		})
		const asked = await access.confirm('w1', 'k1')
		expect(asked.trusted).toBe(false)
		expect(asked.riskySettings).toEqual({ found: ['plugins'], token: 'tok1' })
		expect(trusted).toEqual([])
		const done = await access.confirm('w1', 'k1', asked.riskySettings?.token)
		expect(done.trusted).toBe(true)
		expect(trusted).toEqual(['k1'])
	})
	it('trusts a folder main created without asking', async () => {
		const { access, opened, trusted } = setup({ '/docs/Namzu/New project': ['hooks'] })
		const project = await access.created('/docs/Namzu/New project')
		expect(project.trusted).toBe(true)
		expect(opened).toEqual(['/docs/Namzu/New project'])
		expect(trusted).toEqual(['p0'])
	})
})
