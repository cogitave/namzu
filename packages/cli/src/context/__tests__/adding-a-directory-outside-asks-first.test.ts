/**
 * `/add-dir` of a directory outside the working directory asks first.
 *
 * Adding one lets every file tool reach it with no further question — the
 * question a path there otherwise gets — so it is asked once, here. The
 * session API enforces it, not only the screen: an add nobody confirmed is
 * refused.
 */

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'

import { createSessionDirectories } from '../directories.js'

let base: string
let cwd: string
let outside: string

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), 'namzu-add-dir-'))
	cwd = join(base, 'project')
	outside = join(base, 'elsewhere')
	mkdirSync(join(cwd, 'sub'), { recursive: true })
	mkdirSync(outside)
})

afterEach(() => {
	removeTempDir(base)
})

describe('adding a directory to the session', () => {
	it('asks before adding one outside the working directory, and adds it on yes', async () => {
		const list: string[] = []
		const approve = vi.fn(async () => true)
		const result = await createSessionDirectories(cwd, list).add(outside, { approve })

		expect(approve).toHaveBeenCalledWith(realpathSync(outside))
		expect(result).toEqual({ added: true, path: outside })
		expect(list).toEqual([outside])
	})

	it('leaves it out on no', async () => {
		const list: string[] = []
		const result = await createSessionDirectories(cwd, list).add(outside, {
			approve: async () => false,
		})

		expect(result).toMatchObject({ added: false, reason: 'Not approved.' })
		expect(list).toEqual([])
	})

	it('refuses one outside when nothing can ask', async () => {
		const list: string[] = []
		const result = await createSessionDirectories(cwd, list).add(outside)

		expect(result.added).toBe(false)
		expect(result.reason).toMatch(/needs your approval/)
		expect(list).toEqual([])
	})

	it('does not ask about a directory inside the working directory', async () => {
		const list: string[] = []
		const approve = vi.fn(async () => false)
		const result = await createSessionDirectories(cwd, list).add('sub', { approve })

		expect(approve).not.toHaveBeenCalled()
		expect(result).toEqual({ added: true, path: join(cwd, 'sub') })
	})

	it('does not ask about something it would refuse anyway', async () => {
		const approve = vi.fn(async () => true)
		const dirs = createSessionDirectories(cwd, [])

		expect(await dirs.add(join(base, 'missing'), { approve })).toMatchObject({
			added: false,
			reason: 'Not a directory.',
		})
		expect(await dirs.add(cwd, { approve })).toMatchObject({ added: false })
		expect(approve).not.toHaveBeenCalled()
	})

	it('asks about a link inside the working directory that leads outside it, naming where it leads', async () => {
		// The file tools follow an added directory's links, so a lexical
		// "inside" would let `./link -> elsewhere` in unasked.
		symlinkSync(outside, join(cwd, 'link'))
		const list: string[] = []
		const approve = vi.fn(async () => false)
		const dirs = createSessionDirectories(cwd, list)

		expect(await dirs.add('link', { approve })).toMatchObject({
			added: false,
			reason: 'Not approved.',
		})
		expect(approve).toHaveBeenCalledWith(realpathSync(outside))
		expect(await dirs.add('link')).toMatchObject({
			added: false,
			reason: expect.stringMatching(/needs your approval/),
		})
		expect(list).toEqual([])
	})

	it('does not ask about a link that stays inside the working directory', async () => {
		symlinkSync(join(cwd, 'sub'), join(cwd, 'alias'))
		const approve = vi.fn(async () => false)
		const result = await createSessionDirectories(cwd, []).add('alias', { approve })

		expect(approve).not.toHaveBeenCalled()
		expect(result.added).toBe(true)
	})
})
