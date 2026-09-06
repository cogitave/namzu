import { type ChildProcess, fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { DiskMemoryStore } from '../disk.js'

const DIST = join(import.meta.dirname, '../../../../dist')
const WORKER = join(import.meta.dirname, 'memory-store-worker.mjs')
const roots: string[] = []
const children: ChildProcess[] = []

afterEach(async () => {
	await Promise.all(
		children.splice(0).map(async (child) => {
			if (child.exitCode !== null || child.signalCode !== null) return
			const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
			child.kill('SIGKILL')
			await exited
		}),
	)
	await removeTempDirs(roots.splice(0))
})

interface WorkerResult {
	readonly type: 'done'
	readonly ids: string[]
	readonly bodies?: string[]
}

function worker(mode: string, baseDir: string, id = '') {
	const child = fork(WORKER, [DIST, mode, baseDir, id], { silent: true })
	children.push(child)
	let stderr = ''
	child.stderr?.on('data', (chunk: Buffer) => {
		stderr += chunk.toString()
	})
	let readyResolve!: () => void
	let doneResolve!: (result: WorkerResult) => void
	let rejectReady!: (error: Error) => void
	let rejectDone!: (error: Error) => void
	const ready = new Promise<void>((resolve, reject) => {
		readyResolve = resolve
		rejectReady = reject
	})
	const done = new Promise<WorkerResult>((resolve, reject) => {
		doneResolve = resolve
		rejectDone = reject
	})
	void ready.catch(() => undefined)
	void done.catch(() => undefined)
	child.on('message', (message: { type: string }) => {
		if (message.type === 'ready') readyResolve()
		if (message.type === 'done') doneResolve(message as WorkerResult)
	})
	child.once('error', (error) => {
		rejectReady(error)
		rejectDone(error)
	})
	child.once('exit', (code, signal) => {
		if (code === 0) return
		const error = new Error(`Memory worker exited ${code}/${signal}: ${stderr}`)
		rejectReady(error)
		rejectDone(error)
	})
	return { child, ready, done, start: () => child.send({ type: 'start' }) }
}

it('retains every separate-process save and exposes it to warmed and fresh readers', async () => {
	const baseDir = await mkdtemp(join(tmpdir(), 'namzu-memory-process-writes-'))
	roots.push(baseDir)
	const store = new DiskMemoryStore({ baseDir })
	await store.create({ title: 'seed', summary: '', content: 'seed' })
	const warmed = worker('reader', baseDir)
	await warmed.ready
	const writers = Array.from({ length: 4 }, (_, index) => worker('writer', baseDir, String(index)))
	await Promise.all(writers.map((writer) => writer.ready))
	for (const writer of writers) writer.start()
	const written = (await Promise.all(writers.map((writer) => writer.done))).flatMap(
		(result) => result.ids,
	)
	expect(new Set(written).size).toBe(48)
	warmed.start()
	const observed = await warmed.done
	expect(new Set(observed.ids)).toEqual(new Set(written))
	expect(observed.bodies).toHaveLength(48)
	expect(observed.bodies?.every((body) => body.startsWith('body-only-marker'))).toBe(true)
	const fresh = worker('reader', baseDir)
	await fresh.ready
	fresh.start()
	expect(new Set((await fresh.done).ids)).toEqual(new Set(written))
	expect((await new DiskMemoryStore({ baseDir }).list()).totalCount).toBe(49)
	expect((await readdir(join(baseDir, 'memory/content'))).length).toBe(49)
}, 30_000)

it('does not steal a crashed process lock or silently admit a new writer', async () => {
	const baseDir = await mkdtemp(join(tmpdir(), 'namzu-memory-crashed-writer-'))
	roots.push(baseDir)
	await new DiskMemoryStore({ baseDir }).create({ title: 'seed', summary: '', content: 'seed' })
	const held = worker('hold', baseDir)
	await vi.waitFor(() => expect(existsSync(join(baseDir, 'owner-ready'))).toBe(true), {
		timeout: 5_000,
	})
	const path = join(baseDir, 'memory/operation.lock')
	const owner = await readFile(path, 'utf8')
	expect(JSON.parse(owner).pid).toBe(held.child.pid)
	const exited = new Promise<void>((resolve) => held.child.once('exit', () => resolve()))
	held.child.kill('SIGKILL')
	await exited
	const fresh = new DiskMemoryStore({ baseDir, lockTimeoutMs: 25 })
	await expect(fresh.create({ title: 'blocked', summary: '', content: '' })).rejects.toThrow(
		'acquisition timed out',
	)
	expect(await readFile(path, 'utf8')).toBe(owner)
	expect((await readdir(join(baseDir, 'memory/content'))).length).toBe(1)
}, 10_000)
