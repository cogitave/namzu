import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	MarkdownMemoryStore,
	SESSION_MEMORY_TAG,
	type SessionId,
	type SessionMemoryCandidate,
	type TurnId,
	createMemoryRecallStep,
	createUserMessage,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	ANCHORS_KEY,
	ANCHOR_HASH_MAX_BYTES,
	ANCHOR_MAX,
	anchorsOf,
	checkAnchors,
	createAnchorCaution,
	pathsNamed,
	recordAnchors,
} from './anchors.js'
import { MemoryCurator } from './curator.js'
import { ANCHORS_BROKEN_RETIRE_DAYS, sweepMemory } from './sweep.js'
import { MemoryUsage } from './usage.js'

const DAY = 86_400_000
const roots: string[] = []
afterEach(() => {
	vi.useRealTimers()
	for (const root of roots.splice(0)) removeTempDir(root)
})

/** A project folder with a few files, and a sibling folder that is not the project. */
function project() {
	const base = mkdtempSync(join(tmpdir(), 'namzu-anchors-'))
	roots.push(base)
	const root = join(base, 'repo')
	mkdirSync(join(root, 'src'), { recursive: true })
	writeFileSync(join(root, 'src', 'cache.ts'), 'export const cache = 1\n')
	writeFileSync(join(root, 'package.json'), '{}\n')
	mkdirSync(join(base, 'elsewhere'))
	writeFileSync(join(base, 'elsewhere', 'secret.txt'), 'not the project\n')
	return { base, root }
}

describe('anchors at write time', () => {
	it('records a path that exists in the project, with its size, time and digest, and no content', async () => {
		const { root } = project()
		const anchors = await recordAnchors({
			root,
			text: 'The cache lives in src/cache.ts and the manifest is package.json.',
		})
		expect(anchors.map((anchor) => anchor.path).sort()).toEqual(['package.json', 'src/cache.ts'])
		const cache = anchors.find((anchor) => anchor.path === 'src/cache.ts')
		expect(cache).toMatchObject({ size: 23, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) })
		expect(JSON.stringify(anchors)).not.toContain('export const')
	})

	it('drops a name that is not a file here, and a folder', async () => {
		const { root } = project()
		const anchors = await recordAnchors({
			root,
			text: 'See src/missing.ts, src/ and docs/nowhere/readme.md.',
		})
		expect(anchors).toEqual([])
	})

	it('never anchors a path outside the project: parent, absolute, or through a link', async () => {
		const { base, root } = project()
		symlinkSync(join(base, 'elsewhere'), join(root, 'linked'))
		symlinkSync(join(base, 'elsewhere', 'secret.txt'), join(root, 'src', 'alias.txt'))
		const anchors = await recordAnchors({
			root,
			text: `../elsewhere/secret.txt ${join(base, 'elsewhere', 'secret.txt')} linked/secret.txt src/alias.txt`,
			files: [join(base, 'elsewhere', 'secret.txt'), '../elsewhere/secret.txt'],
		})
		expect(anchors).toEqual([])
	})

	it('takes a touched file the text mentions by name, and not one it does not mention', async () => {
		const { root } = project()
		writeFileSync(join(root, 'src', 'other.ts'), 'x\n')
		const anchors = await recordAnchors({
			root,
			text: 'cache.ts holds the cache.',
			files: [join(root, 'src', 'cache.ts'), join(root, 'src', 'other.ts')],
		})
		expect(anchors.map((anchor) => anchor.path)).toEqual(['src/cache.ts'])
	})

	it('keeps at most five anchors, and anchors a file too large to read by size and time only', async () => {
		const { root } = project()
		const names = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`)
		for (const name of names) writeFileSync(join(root, name), name)
		expect(await recordAnchors({ root, text: names.join(' ') })).toHaveLength(ANCHOR_MAX)
		writeFileSync(join(root, 'big.bin'), Buffer.alloc(ANCHOR_HASH_MAX_BYTES + 1))
		const [big] = await recordAnchors({ root, text: 'big.bin' })
		expect(big?.sha256).toBeUndefined()
		expect(big?.size).toBe(ANCHOR_HASH_MAX_BYTES + 1)
	})

	it('finds paths in prose and ignores addresses', () => {
		const found = pathsNamed(
			'/r',
			'Run `src/a/b.ts`, then (docs/x.md). See https://example.com/a/b.',
		)
		expect(found).toContain('src/a/b.ts')
		expect(found).toContain('docs/x.md')
		expect(found.some((path) => path.startsWith('https'))).toBe(false)
	})
})

describe('anchors at check time', () => {
	it('holds while the file is as it was, and when only its time changed', async () => {
		const { root } = project()
		const anchors = await recordAnchors({ root, text: 'src/cache.ts' })
		expect(await checkAnchors({ root, anchors })).toEqual({ checked: 1 })
		utimesSync(join(root, 'src', 'cache.ts'), new Date(5_000), new Date(5_000))
		expect(await checkAnchors({ root, anchors })).toEqual({ checked: 1 })
	})

	it('says a file is gone', async () => {
		const { root } = project()
		const anchors = await recordAnchors({ root, text: 'src/cache.ts' })
		rmSync(join(root, 'src', 'cache.ts'))
		expect(await checkAnchors({ root, anchors })).toEqual({
			checked: 1,
			broken: { path: 'src/cache.ts', why: 'gone' },
		})
	})

	it('says a file changed when its bytes differ', async () => {
		const { root } = project()
		const anchors = await recordAnchors({ root, text: 'src/cache.ts' })
		writeFileSync(join(root, 'src', 'cache.ts'), 'export const cache = 2 // longer\n')
		expect(await checkAnchors({ root, anchors })).toMatchObject({
			broken: { path: 'src/cache.ts', why: 'changed' },
		})
	})

	it('skips an anchor that points outside the project', async () => {
		const { base, root } = project()
		const anchors = [
			{ path: '../elsewhere/secret.txt', size: 1, mtimeMs: 1, sha256: 'a'.repeat(64) },
			{ path: join(base, 'elsewhere', 'secret.txt'), size: 1, mtimeMs: 1 },
		]
		expect(await checkAnchors({ root, anchors })).toEqual({ checked: 0 })
	})

	it('reads only well formed anchors from metadata', () => {
		expect(
			anchorsOf({
				[ANCHORS_KEY]: [
					{ path: 'a.ts', size: 1, mtimeMs: 2 },
					{ path: '', size: 1, mtimeMs: 2 },
					{ path: 'b.ts', size: -1, mtimeMs: 2 },
					{ path: 'c.ts', size: 1, mtimeMs: 2, sha256: 'nope' },
					'x',
				],
			}),
		).toEqual([{ path: 'a.ts', size: 1, mtimeMs: 2 }])
		expect(anchorsOf(undefined)).toEqual([])
		expect(anchorsOf({ [ANCHORS_KEY]: 'a.ts' })).toEqual([])
	})
})

const candidate = (files: string[] = []): SessionMemoryCandidate => ({
	sessionId: 's1' as SessionId,
	turnId: 't1' as TurnId,
	task: 'notes',
	decisions: [],
	discoveries: ['The cache lives in src/cache.ts'],
	userRequirements: [],
	failures: [],
	environment: [],
	files,
	evicted: {},
})

function curatorFor(root: string, store: MarkdownMemoryStore, reply: () => string) {
	return new MemoryCurator({
		store,
		sideModel: () => ({
			route: async () => ({ providerId: 'p', model: 'm', source: 'cheapest' as const }),
			smallProvider: async () => undefined,
			ask: async () => reply(),
		}),
		fallback: async () => {},
		anchorRoot: root,
	})
}

const addOp = (content: string) =>
	JSON.stringify({
		ops: [
			{
				candidate: 1,
				op: 'add',
				type: 'project',
				title: 'Cache home',
				summary: content,
				content,
				durability: 'project',
				reason: 'r',
			},
		],
	})

describe('the curator records anchors', () => {
	it('stores the files a new memory names, as metadata, and says nothing else of them', async () => {
		const { base, root } = project()
		const store = new MarkdownMemoryStore({ directory: join(base, 'memory') })
		const curator = curatorFor(root, store, () => addOp('The cache lives in src/cache.ts.'))
		const out = await curator.curate([candidate()], {
			sessionId: 's1' as SessionId,
			turnId: 't1' as TurnId,
		})
		expect(out.lines).toEqual(['Remembered: Cache home'])
		const [entry] = (await store.list({})).entries
		const record = await store.get(entry?.id as never)
		expect(anchorsOf(record?.metadata).map((anchor) => anchor.path)).toEqual(['src/cache.ts'])
		expect(record?.content).not.toContain('export const')
		expect(record?.metadata?.source).toBe(SESSION_MEMORY_TAG)
	})

	it('stores no anchor for a memory that names no file of the project', async () => {
		const { base, root } = project()
		const store = new MarkdownMemoryStore({ directory: join(base, 'memory') })
		const curator = curatorFor(root, store, () => addOp('The user prefers pnpm.'))
		await curator.curate([candidate()], { sessionId: 's1' as SessionId, turnId: 't1' as TurnId })
		const [entry] = (await store.list({})).entries
		expect(anchorsOf((await store.get(entry?.id as never))?.metadata)).toEqual([])
	})
})

const QUERY = 'Where does the cache live?'

/** A recall step over a store holding one anchored memory, and the usage file it reports to. */
async function recalling() {
	const { base, root } = project()
	const store = new MarkdownMemoryStore({ directory: join(base, 'memory') })
	const anchors = await recordAnchors({ root, text: 'src/cache.ts' })
	const made = await store.create({
		title: 'Cache home',
		summary: 'Where the cache lives',
		content: 'The cache lives in src/cache.ts.',
		metadata: { source: SESSION_MEMORY_TAG, [ANCHORS_KEY]: anchors },
	})
	let now = 10 * DAY
	const usage = new MemoryUsage({ file: join(base, 'usage.json'), now: () => now })
	await usage.load()
	const caution = createAnchorCaution({ root, usage })
	const recall = () =>
		createMemoryRecallStep({ store, caution })({
			sessionId: 's1' as SessionId,
			turnId: `t${Math.random()}` as TurnId,
			stepNumber: 1,
			messages: [createUserMessage(QUERY)],
			steps: [],
			prepared: {},
		} as never)
	return {
		base,
		root,
		store,
		usage,
		made: made.entry,
		recall,
		at: (value: number) => {
			now = value
		},
	}
}

const textOf = (result: Awaited<ReturnType<ReturnType<typeof createMemoryRecallStep>>>) =>
	JSON.stringify(result)

describe('anchors at selection', () => {
	it('shows a memory whose file is as it was without a caution', async () => {
		const { recall, usage } = await recalling()
		expect(textOf(await recall())).not.toContain('may be out of date')
		expect(usage.get('x')).toBeUndefined()
	})

	it('shows a memory whose file is gone, marked, and counts it in the usage file', async () => {
		const { recall, root, usage, made, at } = await recalling()
		rmSync(join(root, 'src', 'cache.ts'))
		at(11 * DAY)
		const text = textOf(await recall())
		expect(text).toContain(made.id)
		expect(text).toContain('may be out of date: src/cache.ts no longer exists')
		expect(usage.get(made.id)?.brokenSince).toBe(11 * DAY)
		// The first time is kept.
		at(12 * DAY)
		await recall()
		expect(usage.get(made.id)?.brokenSince).toBe(11 * DAY)
		await usage.flush()
		expect(usage.dirty).toBe(false)
	})

	it('marks a memory whose file changed, and lifts the count when the file is back as it was', async () => {
		const { recall, root, usage, made, at } = await recalling()
		const file = join(root, 'src', 'cache.ts')
		writeFileSync(file, 'export const cache = 2 // longer\n')
		at(11 * DAY)
		expect(textOf(await recall())).toContain('has changed')
		expect(usage.get(made.id)?.brokenSince).toBe(11 * DAY)
		writeFileSync(file, 'export const cache = 1\n')
		await recall()
		expect(usage.get(made.id)?.brokenSince).toBeUndefined()
	})

	it('does no file work for a memory without anchors', async () => {
		const { base, root } = project()
		const store = new MarkdownMemoryStore({ directory: join(base, 'memory') })
		await store.create({
			title: 'Cache home',
			summary: 'cache',
			content: 'The cache lives somewhere.',
		})
		const text = JSON.stringify(
			await createMemoryRecallStep({
				store,
				caution: createAnchorCaution({
					root,
					fs: {
						stat: () => Promise.reject(new Error('touched')),
						realpath: () => Promise.reject(new Error('touched')),
						readFile: () => Promise.reject(new Error('touched')),
					},
				}),
			})({
				sessionId: 's1' as SessionId,
				turnId: 't1' as TurnId,
				stepNumber: 1,
				messages: [createUserMessage(QUERY)],
				steps: [],
				prepared: {},
			} as never),
		)
		expect(text).toContain('Cache home')
		expect(text).not.toContain('may be out of date')
	})
})

describe('anchors and the idle sweep', () => {
	it('retires a recorded memory whose anchors stayed broken for the window, and restores it fresh', async () => {
		const { recall, root, usage, made, store, at } = await recalling()
		rmSync(join(root, 'src', 'cache.ts'))
		at(11 * DAY)
		await recall()
		await usage.flush()
		const sweep = (now: number) =>
			sweepMemory({ store, usage, now: () => now, retireAfterDays: 365 })
		// Broken, but not for long enough.
		expect((await sweep(11 * DAY + ANCHORS_BROKEN_RETIRE_DAYS * DAY - 1)).archived).toEqual([])
		const report = await sweep(11 * DAY + ANCHORS_BROKEN_RETIRE_DAYS * DAY)
		expect(report.archived).toEqual([{ id: made.id, title: 'Cache home', reason: 'anchors' }])
		// Restoring starts the clock again.
		usage.restore(made.id)
		expect(usage.get(made.id)?.brokenSince).toBeUndefined()
	})

	it('leaves it alone when its anchors hold, when retiring is off, or when usage is unknown', async () => {
		const { recall, root, usage, store, at, base } = await recalling()
		at(11 * DAY)
		await recall()
		await usage.flush()
		const far = 400 * DAY
		// Anchors that hold retire nothing, however long ago it was recalled.
		expect(
			(await sweepMemory({ store, usage, now: () => far, retireAfterDays: 100_000 })).archived,
		).toEqual([])
		expect(
			(await sweepMemory({ store, usage, now: () => far, retireAfterDays: 0 })).archived,
		).toEqual([])
		rmSync(join(root, 'src', 'cache.ts'))
		await recall()
		expect(usage.get((await store.list({})).entries[0]?.id as string)?.brokenSince).toBe(11 * DAY)
		expect(
			(await sweepMemory({ store, usage, now: () => far, retireAfterDays: 0 })).archived,
		).toEqual([])
		const unknown = new MemoryUsage({ file: join(base, 'missing.json'), now: () => far })
		await unknown.load()
		expect(
			(await sweepMemory({ store, usage: unknown, now: () => far, retireAfterDays: 365 })).archived,
		).toEqual([])
	})

	it('writes the broken-since time to the sidecar and reads it back', async () => {
		const { recall, root, usage, made, at, base } = await recalling()
		rmSync(join(root, 'src', 'cache.ts'))
		at(11 * DAY)
		await recall()
		await usage.flush()
		const again = new MemoryUsage({ file: join(base, 'usage.json'), now: () => 12 * DAY })
		await again.load()
		expect(again.state).toBe('known')
		expect(again.get(made.id)?.brokenSince).toBe(11 * DAY)
	})
})
