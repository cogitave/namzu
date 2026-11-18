import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarkdownMemoryStore, SessionPaths, generateProjectId, slugForCwd } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { loadUserInstructions } from '../../context/instruction-scope.js'
import { MEMORY_HOST_METHODS, createMemoryHost } from '../desktop-host-memory.js'

let root: string
let home: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-host-memory-'))
	home = join(root, 'state')
	cwd = join(root, 'project')
	mkdirSync(join(cwd, '.git'), { recursive: true })
	mkdirSync(home)
	cwd = realpathSync(cwd)
	vi.stubEnv('NAMZU_HOME', home)
})
afterEach(() => {
	vi.unstubAllEnvs()
	removeTempDir(root)
})

const noPal = () => undefined
const host = () => createMemoryHost(cwd, noPal)

async function seed(): Promise<MarkdownMemoryStore> {
	const slug = slugForCwd(cwd)
	const paths = new SessionPaths({ home, slug })
	mkdirSync(paths.projectDir(), { recursive: true })
	writeFileSync(
		paths.projectFile(),
		JSON.stringify({
			v: 1,
			kind: 'project',
			projectId: generateProjectId(),
			cwd,
			slug,
			createdAt: new Date(0).toISOString(),
		}),
	)
	const store = new MarkdownMemoryStore({ directory: paths.memoryDir() })
	await store.create({
		title: 'Prefers tabs',
		summary: 'Tabs not spaces',
		content: 'The person prefers tabs over spaces.',
		type: 'user',
	})
	await store.create({
		title: 'Release day',
		summary: 'Fridays',
		content: 'Releases go out on Fridays.',
		type: 'project',
	})
	return store
}

type Listed = {
	project: boolean
	memories: { id: string; title: string; revision: string; excerpt: string }[]
}

it('offers exactly the methods Desktop probes for', () => {
	expect(Object.keys(host()).sort()).toEqual([...MEMORY_HOST_METHODS].sort())
})

it('reads, saves and clears the person’s own instructions file, the one every conversation loads', () => {
	const h = host()
	expect(h['namzu/instructions/get']({})).toMatchObject({ text: '', limit: 32_000 })
	h['namzu/instructions/set']({ text: 'Keep answers short.' })
	expect(readFileSync(join(home, 'AGENTS.md'), 'utf8')).toBe('Keep answers short.')
	expect(h['namzu/instructions/get']({}).text).toBe('Keep answers short.')
	// The terminal app's loader sees the same text.
	expect(
		loadUserInstructions(home)
			.files.map((file) => file.text)
			.join(''),
	).toContain('Keep answers short.')
	// A hand edit shows at once: nothing is cached.
	writeFileSync(join(home, 'AGENTS.md'), 'Edited by hand.')
	expect(h['namzu/instructions/get']({}).text).toBe('Edited by hand.')
	h['namzu/instructions/set']({ text: '  \n ' })
	expect(existsSync(join(home, 'AGENTS.md'))).toBe(false)
	expect(h['namzu/instructions/get']({}).text).toBe('')
})

it('refuses to overwrite instructions that changed since they were read, and leaves no staging file', () => {
	const h = host()
	h['namzu/instructions/set']({ text: 'First.' })
	const read = h['namzu/instructions/get']({})
	// Edited elsewhere after Desktop loaded it.
	writeFileSync(join(home, 'AGENTS.md'), 'Edited in the terminal app.')
	const refused = h['namzu/instructions/set']({ text: 'Stale draft.', revision: read.revision })
	expect(refused).toMatchObject({ changed: true, text: 'Edited in the terminal app.' })
	expect(readFileSync(join(home, 'AGENTS.md'), 'utf8')).toBe('Edited in the terminal app.')
	// The same refusal covers a clear.
	expect(h['namzu/instructions/set']({ text: '', revision: read.revision })).toMatchObject({
		changed: true,
	})
	expect(existsSync(join(home, 'AGENTS.md'))).toBe(true)
	// Naming the current version saves.
	const current = h['namzu/instructions/get']({})
	const saved = h['namzu/instructions/set']({ text: 'Fresh.', revision: current.revision })
	expect(saved).toMatchObject({ text: 'Fresh.' })
	expect(saved.changed).toBeUndefined()
	expect(readdirSync(home).filter((name) => name.endsWith('.tmp'))).toEqual([])
	expect(() => h['namzu/instructions/set']({ text: 'a', revision: 5 })).toThrow('Invalid revision')
})

it('refuses instructions past the limit, a link in the file’s place, and unknown fields', () => {
	const h = host()
	expect(() => h['namzu/instructions/set']({ text: 'x'.repeat(32_001) })).toThrow('32000')
	expect(() => h['namzu/instructions/set']({ text: 1 })).toThrow('Invalid text')
	expect(() => h['namzu/instructions/set']({ text: 'a', path: '/x' })).toThrow('Invalid')
	writeFileSync(join(root, 'other.md'), 'elsewhere')
	symlinkSync(join(root, 'other.md'), join(home, 'AGENTS.md'))
	expect(h['namzu/instructions/get']({})).toMatchObject({ text: '', limit: 32_000, locked: true })
	expect(() => h['namzu/instructions/set']({ text: 'a' })).toThrow('edit it by hand')
	expect(readFileSync(join(root, 'other.md'), 'utf8')).toBe('elsewhere')
})

it('lists nothing for a folder with no project, and never creates one', async () => {
	expect(await host()['namzu/memory/list']({})).toEqual({ project: false, memories: [] })
	expect(existsSync(join(home, 'projects'))).toBe(false)
})

it('lists, opens, edits and deletes a memory by the version that was shown', async () => {
	const store = await seed()
	const h = host()
	const listed = (await h['namzu/memory/list']({})) as unknown as Listed
	expect(listed.project).toBe(true)
	expect(listed.memories.map((m) => m.title).sort()).toEqual(['Prefers tabs', 'Release day'])
	const tabs = listed.memories.find((m) => m.title === 'Prefers tabs')
	if (!tabs) throw new Error('missing')
	expect(tabs.excerpt).toBe('The person prefers tabs over spaces.')

	const opened = (await h['namzu/memory/read']({ id: tabs.id })) as {
		found: true
		text: string
		revision: string
	}
	expect(opened.text).toBe('The person prefers tabs over spaces.')

	expect((await store.readIndex()).text).toContain('Tabs not spaces')
	expect(
		await h['namzu/memory/update']({
			id: tabs.id,
			revision: opened.revision,
			text: 'The person prefers spaces.',
			title: 'Prefers spaces',
		}),
	).toEqual({ outcome: 'updated' })
	const after = await store.getRecord(tabs.id as never)
	expect(after?.content.content).toBe('The person prefers spaces.')
	expect(after?.entry.title).toBe('Prefers spaces')
	expect(after?.entry.summary).toBe('The person prefers spaces.')
	// The line every later prompt carries holds the new wording, not the replaced one.
	const index = (await store.readIndex()).text
	expect(index).toContain('The person prefers spaces.')
	expect(index).not.toContain('Tabs not spaces')

	// The old version is refused: the memory moved on since it was shown.
	expect(
		await h['namzu/memory/update']({ id: tabs.id, revision: opened.revision, text: 'Stale.' }),
	).toEqual({ outcome: 'changed' })
	expect(await h['namzu/memory/delete']({ id: tabs.id, revision: opened.revision })).toEqual({
		outcome: 'changed',
	})
	expect(await store.getRecord(tabs.id as never)).toBeDefined()

	const fresh = (await h['namzu/memory/list']({})) as unknown as Listed
	const current = fresh.memories.find((m) => m.id === tabs.id)
	if (!current) throw new Error('missing')
	expect(await h['namzu/memory/delete']({ id: tabs.id, revision: current.revision })).toEqual({
		outcome: 'deleted',
	})
	// Final for that one memory only; the other is untouched and the deleted one is not listed or recalled.
	expect(await store.getRecord(tabs.id as never)).toBeUndefined()
	expect(
		((await h['namzu/memory/list']({})) as unknown as Listed).memories.map((m) => m.title),
	).toEqual(['Release day'])
	expect(await h['namzu/memory/delete']({ id: tabs.id, revision: current.revision })).toEqual({
		outcome: 'gone',
	})
})

it('refuses blank text, odd requests and Pals', async () => {
	await seed()
	const h = host()
	await expect(h['namzu/memory/update']({ id: 'a', revision: 'b', text: ' ' })).rejects.toThrow(
		'Invalid text',
	)
	await expect(h['namzu/memory/delete']({ id: 'a' })).rejects.toThrow('Invalid revision')
	await expect(h['namzu/memory/list']({ cwd: '/x' })).rejects.toThrow('Invalid memory request')
	const pal = createMemoryHost(cwd, () => ({ id: 'pal' }))
	await expect(pal['namzu/memory/list']({})).rejects.toThrow('Pals')
	expect(() => pal['namzu/instructions/get']({})).toThrow('Pals')
})
