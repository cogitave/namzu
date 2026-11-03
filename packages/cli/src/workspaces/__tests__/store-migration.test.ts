import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { fileStore, legacySpacesFilePath, workspacesFilePath } from '../store.js'

const session = { label: 'session 1', conversationId: 'conv-a' }

/** What the layout file looked like before the rename: `spaces`, `focus.space`, version 2. */
const OLD_V2 = {
	version: 2,
	spaces: [
		{ name: 'a', cwd: '/work/a', tabs: [{ tree: { session }, name: 'main' }] },
		{ name: 'b', cwd: '/work/b', tabs: [{ tree: { session } }], activeTab: 0 },
	],
	focus: { space: 1 },
	sidebar: { width: 30 },
}

function home() {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-workspaces-store-'))
	const env = { NAMZU_HOME: dir } as NodeJS.ProcessEnv
	return {
		dir,
		env,
		next: workspacesFilePath(env),
		old: legacySpacesFilePath(env),
	}
}

describe('the layout file from before the rename', () => {
	it('is named spaces.json, and the new file is workspaces.json', () => {
		const h = home()
		expect(h.old.endsWith('spaces.json')).toBe(true)
		expect(h.next.endsWith('workspaces.json')).toBe(true)
	})

	it('is read, converted and written to workspaces.json when that file is missing', () => {
		const h = home()
		writeFileSync(h.old, JSON.stringify(OLD_V2))
		const loaded = fileStore(h.next, undefined, h.old).load()
		expect(loaded?.version).toBe(3)
		expect(loaded?.workspaces.map((w) => w.name)).toEqual(['a', 'b'])
		expect(loaded?.focus).toEqual({ workspace: 1 })
		expect(loaded?.sidebar).toEqual({ width: 30 })
		const written = JSON.parse(readFileSync(h.next, 'utf8'))
		expect(written.version).toBe(3)
		expect(written.workspaces).toHaveLength(2)
		expect(written.spaces).toBeUndefined()
	})

	it('is never modified or removed', () => {
		const h = home()
		const body = JSON.stringify(OLD_V2)
		writeFileSync(h.old, body)
		const store = fileStore(h.next, undefined, h.old)
		store.save(store.load() ?? { version: 3, workspaces: [] })
		expect(readFileSync(h.old, 'utf8')).toBe(body)
	})

	it('is not read once workspaces.json exists', () => {
		const h = home()
		writeFileSync(h.old, JSON.stringify(OLD_V2))
		writeFileSync(
			h.next,
			JSON.stringify({
				version: 3,
				workspaces: [{ name: 'only', cwd: '/work/only', tabs: [{ tree: { session } }] }],
			}),
		)
		expect(
			fileStore(h.next, undefined, h.old)
				.load()
				?.workspaces.map((w) => w.name),
		).toEqual(['only'])
	})

	it('migrates a version 1 file too', () => {
		const h = home()
		writeFileSync(
			h.old,
			JSON.stringify({
				version: 1,
				spaces: [{ name: 'a', cwd: '/work/a', sessions: [session, { label: 'two' }] }],
				focus: { space: 0, session: 1 },
			}),
		)
		const loaded = fileStore(h.next, undefined, h.old).load()
		expect(loaded?.workspaces[0]?.tabs).toHaveLength(2)
		expect(loaded?.workspaces[0]?.activeTab).toBe(1)
	})

	it('leaves a file from a newer version alone and says so', () => {
		const h = home()
		const body = JSON.stringify({ version: 9, spaces: [] })
		writeFileSync(h.old, body)
		const said: string[] = []
		const store = fileStore(h.next, (message) => said.push(message), h.old)
		expect(store.load()).toBeUndefined()
		store.save({ version: 3, workspaces: [] })
		expect(said).toHaveLength(1)
		expect(existsSync(h.next)).toBe(false)
		expect(readFileSync(h.old, 'utf8')).toBe(body)
	})

	it('gives an empty layout when neither file exists', () => {
		const h = home()
		expect(fileStore(h.next, undefined, h.old).load()).toBeUndefined()
		expect(existsSync(h.next)).toBe(false)
	})
})
