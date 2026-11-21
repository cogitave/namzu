import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { createLeadership, processExists, readLock } from './leader.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function dir() {
	const root = mkdtempSync(join(tmpdir(), 'nl-'))
	roots.push(root)
	return join(root, 'network')
}

const alive = new Set<number>()
const make = (path: string, pid: number) => {
	alive.add(pid)
	return createLeadership({ dir: path, pid, now: () => 1, isAlive: (p) => alive.has(p) })
}

it('the first terminal leads and the second follows, and the directory and lock are private', () => {
	const path = dir()
	const first = make(path, 101)
	const second = make(path, 102)
	expect(first.tryAcquire()).toBe(true)
	expect(second.tryAcquire()).toBe(false)
	expect(second.holder()?.pid).toBe(101)
	expect(statSync(path).mode & 0o077).toBe(0)
	expect(statSync(join(path, 'leader.lock')).mode & 0o077).toBe(0)
})

it('leading again is the same lead, not a takeover', () => {
	const first = make(dir(), 111)
	expect(first.tryAcquire()).toBe(true)
	expect(first.tryAcquire()).toBe(true)
	expect(first.isLeader).toBe(true)
})

it('takes over a lock whose process is gone, and only then', () => {
	const path = dir()
	const first = make(path, 121)
	const second = make(path, 122)
	first.tryAcquire()
	expect(second.tryAcquire()).toBe(false)
	alive.delete(121)
	expect(second.tryAcquire()).toBe(true)
	expect(readLock(path)?.pid).toBe(122)
})

it('takes over a lock nobody can read', () => {
	const path = dir()
	const first = make(path, 131)
	first.tryAcquire()
	first.release()
	writeFileSync(join(path, 'leader.lock'), 'not json')
	const second = make(path, 132)
	expect(second.tryAcquire()).toBe(true)
})

it('releases only a lock it wrote', () => {
	const path = dir()
	const first = make(path, 141)
	const second = make(path, 142)
	first.tryAcquire()
	second.release()
	expect(readLock(path)?.pid).toBe(141)
	first.release()
	expect(readLock(path)).toBeUndefined()
	expect(first.isLeader).toBe(false)
})

it('steps down when the lock names another live terminal', () => {
	const path = dir()
	const first = make(path, 151)
	const second = make(path, 152)
	first.tryAcquire()
	writeFileSync(join(path, 'leader.lock'), JSON.stringify({ pid: 152, startedAt: 2 }))
	expect(first.tryAcquire()).toBe(false)
	expect(second.tryAcquire()).toBe(true)
})

it('knows this process exists and an impossible one does not', () => {
	expect(processExists(process.pid)).toBe(true)
	expect(processExists(2 ** 22 + 12345)).toBe(false)
})

it('never lets a reader see the lock without its content, and leaves no temp file', () => {
	const path = dir()
	expect(make(path, 4242).tryAcquire()).toBe(true)
	expect(readLock(path)).toMatchObject({ pid: 4242 })
	expect(readdirSync(path).filter((f) => f.endsWith('.tmp'))).toEqual([])
})
