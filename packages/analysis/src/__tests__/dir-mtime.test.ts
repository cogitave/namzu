import { utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// An entry created while the walk is between listing a directory and
// recording its time. The hook creates it right after the real listing.
const hook = vi.hoisted(() => ({ afterList: undefined as undefined | ((dir: string) => void) }))
vi.mock('node:fs/promises', async (importOriginal) => {
	const real = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...real,
		readdir: (async (...args: Parameters<typeof real.readdir>) => {
			const out = await (real.readdir as (...a: unknown[]) => Promise<unknown>)(...args)
			hook.afterList?.(String(args[0]))
			return out
		}) as typeof real.readdir,
	}
})

import { Tree, ok, provider } from './helpers.js'

const trees: Tree[] = []
afterEach(() => {
	hook.afterList = undefined
	for (const t of trees.splice(0)) t.dispose()
})

describe('the directory time is taken before the listing', () => {
	it('notices a file created between the listing and the end of the walk', async () => {
		const tree = new Tree({ 'a.js': 'export const a = "a-lit"\n' })
		trees.push(tree)
		// Old times, so the file created below moves the directory time for sure.
		utimesSync(tree.root, 1_700_000_000, 1_700_000_000)
		let created = false
		hook.afterList = (dir) => {
			if (created || dir !== tree.root) return
			created = true
			writeFileSync(join(tree.root, 'late.js'), 'export const late = "late-lit"\n')
		}
		const p = provider()
		ok(await p.index({ root: tree.root }))
		hook.afterList = undefined
		expect(created).toBe(true)
		// Listed before it existed, so the index does not hold it; the directory
		// time recorded must be older than the file, and the next query re-reads.
		const r = ok(await p.findLiteral({ root: tree.root, text: 'late-lit' }))
		expect(r.value.total).toBe(1)
		await p.dispose()
	})
})
