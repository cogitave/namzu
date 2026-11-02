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
	it('reads a file inside the working directory', async () => {
		const cwd = scratch()
		const policy = createImageReadPolicy({})
		expect(await policy(join(cwd, 'shot.png'))).toBeNull()
	})

	it('reads a file outside the project, because the operator pasted it themself', async () => {
		const cwd = scratch()
		const elsewhere = scratch()
		const policy = createImageReadPolicy({
			rules: () => [pathRule('read', 'private/**', 'deny', { cwd })],
		})
		expect(await policy(join(elsewhere, 'shot.png'))).toBeNull()
	})

	it('refuses a path a deny rule names, even inside the working directory', async () => {
		const cwd = scratch()
		mkdirSync(join(cwd, 'private'))
		const policy = createImageReadPolicy({
			rules: () => [pathRule('read', 'private/**', 'deny', { cwd })],
		})
		expect(await policy(join(cwd, 'private', 'a.png'))).toContain('permission rule keeps')
		expect(await policy(join(cwd, 'public.png'))).toBeNull()
	})

	it('refuses a path outside the project that a deny rule names', async () => {
		const elsewhere = scratch()
		const policy = createImageReadPolicy({
			rules: () => [pathRule('read', `/${elsewhere}/**`, 'deny', { cwd: elsewhere })],
		})
		expect(await policy(join(elsewhere, 'a.png'))).toContain('permission rule keeps')
	})

	it('refuses a link whose target a deny rule names', async () => {
		const cwd = scratch()
		const vault = scratch()
		writeFileSync(join(vault, 'secret.png'), 'x')
		symlinkSync(join(vault, 'secret.png'), join(cwd, 'innocent.png'))
		const policy = createImageReadPolicy({
			rules: () => [pathRule('read', `/${vault}/**`, 'deny', { cwd: vault })],
		})
		expect(await policy(join(cwd, 'innocent.png'))).toContain('permission rule keeps')
	})

	it('does not refuse a path an ask rule names', async () => {
		const cwd = scratch()
		const policy = createImageReadPolicy({
			rules: () => [pathRule('read', '**/*.png', 'ask', { cwd })],
		})
		expect(await policy(join(cwd, 'a.png'))).toBeNull()
	})

	it('leaves a missing file to the reader, which keeps the paste as text', async () => {
		const cwd = scratch()
		const policy = createImageReadPolicy({
			rules: () => [pathRule('read', 'private/**', 'deny', { cwd })],
		})
		expect(await policy(join(cwd, 'gone.png'))).toBeNull()
	})
})
