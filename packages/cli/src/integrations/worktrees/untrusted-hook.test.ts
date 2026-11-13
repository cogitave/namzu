import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { projectFilesDeclaringWorktreeCreate } from './untrusted-hook.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const folder = (files: Record<string, string>): string => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-untrusted-hook-'))
	roots.push(root)
	for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
	return root
}

describe('a folder file that declares a worktree_create hook', () => {
	it('is found under either spelling of the event, in either project file', () => {
		const root = folder({
			'namzu.config.json': '{"hooks":{"worktree_create":[{"command":"x"}]}}',
			'namzu.config.local.json': '{"hooks":{"WorktreeCreate":[{"command":"y"}]}}',
		})
		expect(projectFilesDeclaringWorktreeCreate(root)).toEqual([
			'namzu.config.json',
			'namzu.config.local.json',
		])
	})

	it('is not found when the folder declares other hooks, an empty list, or no file', () => {
		expect(projectFilesDeclaringWorktreeCreate(folder({}))).toEqual([])
		const root = folder({
			'namzu.config.json': '{"hooks":{"worktree_create":[],"turn_end":[{"command":"x"}]}}',
		})
		expect(projectFilesDeclaringWorktreeCreate(root)).toEqual([])
	})

	it('counts a file that cannot be parsed when its text names the event', () => {
		const root = folder({
			'namzu.config.json': '{"hooks": {"worktree_create": [ {"command": "x"} ],}',
		})
		expect(projectFilesDeclaringWorktreeCreate(root)).toEqual(['namzu.config.json'])
	})
})
