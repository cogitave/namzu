import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createImageReadPolicy } from '../image-read.js'
import { pathRule } from '../path-rules.js'

const made: string[] = []
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-image-read-'))
	made.push(dir)
	return dir
}
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('reading a pasted image path', () => {
	it('allows a file inside the working directory', async () => {
		const cwd = scratch()
		const policy = createImageReadPolicy({ cwd: () => cwd })
		expect(await policy(join(cwd, 'shot.png'))).toBeNull()
	})

	it('refuses a file outside every folder, and says how to widen the reach', async () => {
		const cwd = scratch()
		const elsewhere = scratch()
		const policy = createImageReadPolicy({ cwd: () => cwd })
		const message = await policy(join(elsewhere, 'shot.png'))
		expect(message).toContain('outside the folders this session can read')
		expect(message).toContain('/add-dir')
	})

	it('allows a file in an added directory', async () => {
		const cwd = scratch()
		const added = scratch()
		const policy = createImageReadPolicy({ cwd: () => cwd, additionalDirectories: () => [added] })
		expect(await policy(join(added, 'a.png'))).toBeNull()
	})

	it('follows a link out of the folder instead of trusting its spelling', async () => {
		const cwd = scratch()
		const outside = scratch()
		writeFileSync(join(outside, 'secret.png'), 'x')
		symlinkSync(outside, join(cwd, 'link'))
		const policy = createImageReadPolicy({ cwd: () => cwd })
		expect(await policy(join(cwd, 'link', 'secret.png'))).toContain('outside the folders')
	})

	it('refuses a path a deny rule names, even inside the working directory', async () => {
		const cwd = scratch()
		mkdirSync(join(cwd, 'private'))
		const policy = createImageReadPolicy({
			cwd: () => cwd,
			rules: () => [pathRule('read', 'private/**', 'deny', { cwd })],
		})
		expect(await policy(join(cwd, 'private', 'a.png'))).toContain('permission rule keeps')
		expect(await policy(join(cwd, 'public.png'))).toBeNull()
	})

	it('refuses a path an ask rule names, because nobody is there to answer', async () => {
		const cwd = scratch()
		const policy = createImageReadPolicy({
			cwd: () => cwd,
			rules: () => [pathRule('read', '**/*.png', 'ask', { cwd })],
		})
		expect(await policy(join(cwd, 'a.png'))).toContain('asks before reading')
	})
})
