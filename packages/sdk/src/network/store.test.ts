import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { generateMachineKey } from './identity.js'
import { createNetworkStore } from './store.js'

const dirs: string[] = []
afterEach(() => {
	for (const d of dirs.splice(0)) removeTempDir(d)
})
const home = () => {
	const d = mkdtempSync(join(tmpdir(), 'namzu-net-store-'))
	dirs.push(d)
	return d
}

describe('network store', () => {
	it('creates nothing until something is written', async () => {
		const h = home()
		const store = createNetworkStore({ home: h })
		expect(store.exists()).toBe(false)
		expect((await store.readMachine()).status).toBe('missing')
		expect(readdirSync(h)).toEqual([])
	})

	it('writes a private directory and private files, and keeps the key out of other files', async () => {
		const h = home()
		const store = createNetworkStore({ home: h })
		const key = generateMachineKey()
		await store.writeKey(key)
		await store.writeMachine({ v: 1, machineId: key.machineId, name: 'studio', createdAt: 1 })
		if (process.platform !== 'win32') {
			expect(statSync(store.dir).mode & 0o777).toBe(0o700)
			expect(statSync(store.file('machine.key.pem')).mode & 0o777).toBe(0o600)
			expect(statSync(store.file('machine.json')).mode & 0o777).toBe(0o600)
		}
		expect(readFileSync(store.file('machine.json'), 'utf8')).not.toContain('PRIVATE')
		const read = await store.readKey()
		expect(read.status === 'ok' && read.value.machineId).toBe(key.machineId)
	})

	it('moves a corrupt file aside and reports it instead of throwing', async () => {
		const h = home()
		const store = createNetworkStore({ home: h, now: () => 42 })
		await store.writeMachine({ v: 1, machineId: 'a'.repeat(64), createdAt: 1 })
		writeFileSync(store.file('machine.json'), '{ not json')
		expect((await store.readMachine()).status).toBe('corrupt')
		expect(readdirSync(store.dir)).toContain('machine.json.corrupt-42')
		expect((await store.readMachine()).status).toBe('missing')
		writeFileSync(store.file('machine.key.pem'), 'garbage')
		expect((await store.readKey()).status).toBe('corrupt')
	})

	it('resets identity and network but keeps the audit log', async () => {
		const h = home()
		const store = createNetworkStore({ home: h })
		await store.writeKey(generateMachineKey())
		writeFileSync(store.file('audit.jsonl'), '{}\n')
		await store.reset()
		expect(readdirSync(store.dir)).toEqual(['audit.jsonl'])
	})
})
