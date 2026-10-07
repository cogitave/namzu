import { chmod, lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ToolContext, ToolDefinition, ToolResult } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileCheckpointStore, renderCheckpoints } from '../store.js'
import { withCheckpoints } from '../wrap.js'

// Real-filesystem tests: no timers, no sleeps; Vitest's own timeout guards a hang.
let cwd: string
let store: FileCheckpointStore

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-ckpt-safety-'))
	store = new FileCheckpointStore(join(cwd, '.namzu', 'file-history'), cwd)
	store.beginTurn('turn')
})

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true })
})

const logs: string[] = []
function context(extra: Partial<ToolContext> = {}): ToolContext {
	return {
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log: (_level: string, message: string) => logs.push(message),
		...extra,
	} as unknown as ToolContext
}

function tool(run: (input: { path: string }) => Promise<ToolResult>): ToolDefinition {
	return {
		name: 'edit',
		execute: async (input: unknown) => run(input as { path: string }),
	} as unknown as ToolDefinition
}

describe('a sandboxed tool call', () => {
	it('never snapshots or restores the host path of the same name', async () => {
		const host = join(cwd, 'same.txt')
		await writeFile(host, 'host content')
		let ran = 0
		const wrapped = withCheckpoints(
			tool(async () => {
				ran++
				return { success: true, output: '' }
			}),
			store,
		)
		await wrapped.execute({ path: 'same.txt' }, context({ sandbox: {} as ToolContext['sandbox'] }))
		expect(ran).toBe(1)
		expect(store.list()).toEqual([])
		expect(store.skippedPaths()).toEqual([{ path: host, reason: 'sandbox', turn: 1 }])
		// The host file survives a restore request: there is nothing to restore.
		await expect(store.restore(1)).rejects.toThrow(/No checkpoint/)
		expect(await readFile(host, 'utf8')).toBe('host content')
		expect(renderCheckpoints(store.list(), cwd, store.skippedPaths())).toContain(
			'same.txt  (edited in the sandbox)',
		)
	})
})

describe('skipped paths', () => {
	it('carry a typed reason for too-large, outside and failed snapshots', async () => {
		const big = join(cwd, 'big.bin')
		await writeFile(big, Buffer.alloc(8 * 1024 * 1024 + 1))
		expect(await store.snapshot(big)).toBe('too-large')
		expect(await store.snapshot('../x.txt')).toBe('outside')
		// A directory cannot be read as a file: the snapshot throws, the wrapper records it.
		const dir = join(cwd, 'adir')
		await import('node:fs/promises').then((fs) => fs.mkdir(dir))
		const wrapped = withCheckpoints(
			tool(async () => ({ success: true, output: '' })),
			store,
		)
		await wrapped.execute({ path: dir }, context())
		expect(store.skippedPaths().map((s) => s.reason)).toEqual([
			'too-large',
			'outside-cwd',
			'snapshot-failed',
		])
	})
})

describe('a failed edit', () => {
	it('leaves no entry when the file still equals its snapshot', async () => {
		const file = join(cwd, 'a.txt')
		await writeFile(file, 'one')
		const refused = withCheckpoints(
			tool(async () => ({ success: false, output: '', error: 'no match' })),
			store,
		)
		await refused.execute({ path: file }, context())
		const thrown = withCheckpoints(
			tool(async () => {
				throw new Error('boom')
			}),
			store,
		)
		await expect(thrown.execute({ path: file }, context())).rejects.toThrow('boom')
		expect(store.list()).toEqual([])
		expect(await readdir(join(cwd, '.namzu', 'file-history', 'blobs'))).toEqual([])
	})

	it('leaves no entry for a created file that was never written', async () => {
		const file = join(cwd, 'new.txt')
		const refused = withCheckpoints(
			tool(async () => ({ success: false, output: '' })),
			store,
		)
		await refused.execute({ path: file }, context())
		expect(store.list()).toEqual([])
	})

	it('keeps the entry when the failed call had already changed the file', async () => {
		const file = join(cwd, 'a.txt')
		await writeFile(file, 'one')
		const partial = withCheckpoints(
			tool(async ({ path }) => {
				await writeFile(path, 'half')
				return { success: false, output: '' }
			}),
			store,
		)
		await partial.execute({ path: file }, context())
		expect(store.list().length).toBe(1)
		await store.restore(1)
		expect(await readFile(file, 'utf8')).toBe('one')
	})

	it('keeps an earlier successful edit of the same path when a later one fails', async () => {
		const file = join(cwd, 'a.txt')
		await writeFile(file, 'one')
		const ok = withCheckpoints(
			tool(async ({ path }) => {
				await writeFile(path, 'two')
				return { success: true, output: '' }
			}),
			store,
		)
		const bad = withCheckpoints(
			tool(async () => ({ success: false, output: '' })),
			store,
		)
		await ok.execute({ path: file }, context())
		await bad.execute({ path: file }, context())
		expect(store.list().length).toBe(1)
		await store.restore(1)
		expect(await readFile(file, 'utf8')).toBe('one')
	})
})

describe('a restore', () => {
	const settled = (p: string) => store.settle(p, { ok: true, first: true })
	it('keeps the mode bits and leaves no temp file behind', async () => {
		if (process.platform === 'win32') return
		const file = join(cwd, 'run.sh')
		await writeFile(file, '#!/bin/sh\n')
		await chmod(file, 0o751)
		await store.snapshot(file)
		await writeFile(file, 'changed')
		await chmod(file, 0o600)
		await settled(file)
		await store.restore(1)
		expect(await readFile(file, 'utf8')).toBe('#!/bin/sh\n')
		expect((await stat(file)).mode & 0o7777).toBe(0o751)
		expect((await readdir(cwd)).filter((n) => n.endsWith('.tmp'))).toEqual([])
	})

	it('restores binary bytes exactly', async () => {
		const file = join(cwd, 'b.bin')
		const bytes = Buffer.from([0, 255, 128, 10, 13, 0xc3, 0x28])
		await writeFile(file, bytes)
		await store.snapshot(file)
		await writeFile(file, 'text')
		await settled(file)
		await store.restore(1)
		expect((await readFile(file)).equals(bytes)).toBe(true)
	})

	it('leaves a symlink that took the place of the file alone, and writes nothing through it', async () => {
		if (process.platform === 'win32') return
		const outside = await mkdtemp(join(tmpdir(), 'namzu-ckpt-outside-'))
		try {
			const target = join(outside, 'target.txt')
			await writeFile(target, 'untouched')
			const file = join(cwd, 'a.txt')
			await writeFile(file, 'orig')
			await store.snapshot(file)
			await writeFile(file, 'edited')
			await settled(file)
			await rm(file)
			await import('node:fs/promises').then((fs) => fs.symlink(target, file))
			const report = await store.restore(1)
			expect(report.conflicts).toEqual([{ path: file, turn: 1, reason: 'symlink' }])
			expect((await lstat(file)).isSymbolicLink()).toBe(true)
			expect(await readFile(target, 'utf8')).toBe('untouched')
		} finally {
			await rm(outside, { recursive: true, force: true })
		}
	})

	it('leaves a directory that took the place of the file alone, with no temp file', async () => {
		const file = join(cwd, 'a.txt')
		await writeFile(file, 'orig')
		await store.snapshot(file)
		await writeFile(file, 'edited')
		await settled(file)
		await rm(file)
		await import('node:fs/promises').then((fs) => fs.mkdir(file))
		const report = await store.restore(1)
		expect(report.conflicts.map((c) => c.path)).toEqual([file])
		expect((await stat(file)).isDirectory()).toBe(true)
		expect((await readdir(cwd)).filter((n) => n.endsWith('.tmp'))).toEqual([])
	})

	it('restores through a link inside the project and keeps the link', async () => {
		if (process.platform === 'win32') return
		const { symlink } = await import('node:fs/promises')
		const real = join(cwd, 'real.txt')
		const link = join(cwd, 'link.txt')
		await writeFile(real, 'orig')
		await symlink(real, link)
		expect(await store.snapshot(link)).toBe('recorded')
		await writeFile(link, 'edited')
		await settled(link)
		await store.restore(1)
		expect((await lstat(link)).isSymbolicLink()).toBe(true)
		expect(await readFile(real, 'utf8')).toBe('orig')
	})

	it('does not follow a link out of the project', async () => {
		if (process.platform === 'win32') return
		const { symlink } = await import('node:fs/promises')
		const outside = await mkdtemp(join(tmpdir(), 'namzu-ckpt-outside-'))
		try {
			await writeFile(join(outside, 't.txt'), 'theirs')
			await symlink(join(outside, 't.txt'), join(cwd, 'link.txt'))
			await symlink(outside, join(cwd, 'dir'))
			expect(await store.snapshot(join(cwd, 'link.txt'))).toBe('outside')
			expect(await store.snapshot(join(cwd, 'dir', 'new.txt'))).toBe('outside')
			expect(store.list()).toEqual([])
		} finally {
			await rm(outside, { recursive: true, force: true })
		}
	})

	it('records one entry when two edits of a file snapshot together', async () => {
		const file = join(cwd, 'a.txt')
		await writeFile(file, 'orig')
		const [a, b] = await Promise.all([store.snapshot(file), store.snapshot(file)])
		expect([a, b].sort()).toEqual(['already', 'recorded'])
		await writeFile(file, 'edited')
		await settled(file)
		await store.restore(1)
		expect(await readFile(file, 'utf8')).toBe('orig')
	})

	it('a snapshot that overlaps a restore waits for it, and the turn is then partly undone', async () => {
		const file = join(cwd, 'a.txt')
		await writeFile(file, 'orig')
		await store.snapshot(file)
		await writeFile(file, 'edited')
		await settled(file)
		const restoring = store.restore(1)
		const snapping = store.snapshot(file)
		await restoring
		expect(await readFile(file, 'utf8')).toBe('orig')
		// The undone turn keeps its history, so this is another write to the same file.
		expect(await snapping).toBe('already')
		await writeFile(file, 'edited again')
		await settled(file)
		expect(store.list().map((t) => [t.files.length, t.status])).toEqual([[1, 'partially_undone']])
	})
})
