import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearStorage, measureStorage, measureTree } from './storage-usage.js'

let userData: string
let namzuHome: string
const layout = () => ({ userData, namzuHome })
const file = (path: string, size: number) => {
	mkdirSync(join(path, '..'), { recursive: true })
	writeFileSync(path, Buffer.alloc(size))
}

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-storage-'))
	userData = join(root, 'app')
	namzuHome = join(root, 'home')
	mkdirSync(userData)
	mkdirSync(namzuHome)
})

describe('measuring storage', () => {
	it('counts files, treats a missing folder as empty and never follows a link', async () => {
		file(join(userData, 'a', 'one'), 100)
		file(join(userData, 'a', 'b', 'two'), 50)
		file(join(namzuHome, 'outside'), 1000)
		symlinkSync(namzuHome, join(userData, 'a', 'link'))
		expect(await measureTree(join(userData, 'a'))).toEqual({ bytes: 150, approximate: false })
		expect(await measureTree(join(userData, 'absent'))).toEqual({ bytes: 0, approximate: false })
	})

	it('splits the app folder by part and leaves the rest as Other', async () => {
		file(join(namzuHome, 'sessions', 's'), 400)
		file(join(userData, 'kernel', 'engine'), 300)
		file(join(userData, 'local-speech', 'm'), 200)
		file(join(userData, 'local-listening', 'm'), 20)
		file(join(userData, 'logs', 'desktop.ndjson'), 10)
		file(join(userData, 'Cache', 'c'), 5)
		file(join(userData, 'GPUCache', 'g'), 5)
		file(join(userData, 'desktop-settings.json'), 7)
		const report = await measureStorage(layout())
		const by = Object.fromEntries(report.parts.map((part) => [part.id, part.bytes]))
		expect(by).toEqual({
			conversations: 400,
			engine: 300,
			voice: 220,
			logs: 10,
			caches: 10,
			other: 7,
		})
		expect(report.totalBytes).toBe(947)
		expect(report.parts.filter((part) => part.clearable).map((part) => part.id)).toEqual([
			'logs',
			'caches',
		])
	})

	it('does not count the command line home twice when it sits in the app folder', async () => {
		namzuHome = join(userData, 'nested-home')
		file(join(namzuHome, 'x'), 100)
		file(join(userData, 'settings'), 3)
		const report = await measureStorage(layout())
		expect(report.parts.find((part) => part.id === 'other')?.bytes).toBe(3)
	})
})

describe('clearing storage', () => {
	it('empties logs but keeps the log being written, and caches entirely', async () => {
		file(join(userData, 'logs', 'desktop.ndjson'), 10)
		file(join(userData, 'logs', 'desktop.previous.ndjson'), 10)
		file(join(userData, 'Code Cache', 'js', 'x'), 10)
		const afterLogs = await clearStorage(layout(), 'logs')
		expect(existsSync(join(userData, 'logs', 'desktop.ndjson'))).toBe(true)
		expect(existsSync(join(userData, 'logs', 'desktop.previous.ndjson'))).toBe(false)
		expect(afterLogs.parts.find((part) => part.id === 'logs')?.bytes).toBe(10)
		const afterCaches = await clearStorage(layout(), 'caches')
		expect(existsSync(join(userData, 'Code Cache', 'js'))).toBe(false)
		expect(afterCaches.parts.find((part) => part.id === 'caches')?.bytes).toBe(0)
	})

	it('refuses every part that holds work, settings or keys, and anything unknown', async () => {
		file(join(namzuHome, 'sessions', 's'), 1)
		file(join(userData, 'desktop-settings.json'), 1)
		for (const id of ['conversations', 'engine', 'voice', 'other', '../home', undefined])
			await expect(clearStorage(layout(), id)).rejects.toThrow('cannot be cleared')
		expect(existsSync(join(namzuHome, 'sessions', 's'))).toBe(true)
		expect(existsSync(join(userData, 'desktop-settings.json'))).toBe(true)
	})

	it('clears an absent part without failing', async () => {
		await expect(clearStorage(layout(), 'caches')).resolves.toBeTruthy()
	})
})
