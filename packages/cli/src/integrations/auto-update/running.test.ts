import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { scopeOf, sharedStateHome } from './apply.js'
import type { InstallKind } from './install-kind.js'
import { otherRunning, registerRunning, registerRunningSession } from './running.js'

type Updatable = Extract<InstallKind, { kind: 'npm-global' }>

let dir: string
let install: Updatable

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-running-'))
	install = {
		kind: 'npm-global',
		root: join(dir, 'prefix', 'lib', 'node_modules', '@namzu', 'cli'),
		prefix: join(dir, 'prefix'),
		owned: false,
		writable: true,
	}
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const folder = () =>
	join(sharedStateHome(install), 'updates', 'running', scopeOf(install, process.platform))

describe('which processes run from an install', () => {
	it('records a process inside the install, where every Namzu home sees it, and forgets it', () => {
		const stop = registerRunning(install, { pid: 4001, version: '1.2.3' })
		expect(JSON.parse(readFileSync(join(folder(), '4001.json'), 'utf8'))).toEqual({
			pid: 4001,
			version: '1.2.3',
		})
		expect(otherRunning(install, { isAlive: () => true })).toEqual([4001])
		stop()
		expect(existsSync(join(folder(), '4001.json'))).toBe(false)
		expect(otherRunning(install, { isAlive: () => true })).toEqual([])
	})

	it('leaves out the caller itself and names the others', () => {
		registerRunning(install, { pid: 10 })
		registerRunning(install, { pid: 11 })
		expect(otherRunning(install, { except: 10, isAlive: () => true })).toEqual([11])
	})

	it('ignores, and removes, the record of a process that is gone, so a killed window holds nothing back', () => {
		registerRunning(install, { pid: 20 })
		registerRunning(install, { pid: 21 })
		expect(otherRunning(install, { isAlive: (pid) => pid === 21 })).toEqual([21])
		expect(existsSync(join(folder(), '20.json'))).toBe(false)
	})

	it('ignores files that are not records and an install that was never used', () => {
		expect(otherRunning(install)).toEqual([])
		mkdirSync(folder(), { recursive: true })
		writeFileSync(join(folder(), 'notes.txt'), 'x')
		expect(otherRunning(install, { isAlive: () => true })).toEqual([])
	})

	it('keeps two installs apart', () => {
		const other: Updatable = {
			...install,
			prefix: join(dir, 'other'),
			root: join(dir, 'other', 'lib', 'node_modules', '@namzu', 'cli'),
		}
		registerRunning(install, { pid: 30 })
		expect(otherRunning(other, { isAlive: () => true })).toEqual([])
	})

	it('still records a window that has updates switched off, so a swap by another window keeps its files', () => {
		const find = () => ({ install, home: join(dir, 'home') })
		const stop = registerRunningSession({ NAMZU_UPDATE_CHECK: '0', NAMZU_AUTO_UPDATE: '0' }, find)
		expect(existsSync(join(folder(), `${process.pid}.json`))).toBe(true)
		stop()
		expect(existsSync(join(folder(), `${process.pid}.json`))).toBe(false)
	})

	it('writes nothing for a copy that is never updated', () => {
		registerRunningSession({}, () => null)()
		expect(existsSync(sharedStateHome(install))).toBe(false)
	})

	it('writes a record when updates are on, and clears the records of windows that were killed', () => {
		registerRunning(install, { pid: 2_147_000_001 })
		const find = () => ({ install, home: join(dir, 'home') })
		const stop = registerRunningSession({}, find)
		expect(existsSync(join(folder(), `${process.pid}.json`))).toBe(true)
		expect(existsSync(join(folder(), '2147000001.json'))).toBe(false)
		stop()
		expect(existsSync(join(folder(), `${process.pid}.json`))).toBe(false)
	})
})
