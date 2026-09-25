import { readFile, writeFile } from 'node:fs/promises'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { defineSessionLogConformance } from '../conformance.js'
import { DiskSessionLog } from '../disk.js'
import { InMemorySessionLog } from '../memory.js'

const made: string[] = []
afterAll(async () => {
	await removeTempDirs(made.splice(0))
})

defineSessionLogConformance({
	describe,
	it,
	expect,
	label: 'InMemorySessionLog',
	contractVersion: 2,
	makeLog: (sessionId) => {
		const log = new InMemorySessionLog({ sessionId })
		return {
			log,
			reopen: () => log.reopen(),
			tamper: {
				bytes: async () => log.medium.bytes(),
				overwrite: async (bytes) => log.medium.overwrite(bytes),
			},
		}
	},
})

defineSessionLogConformance({
	describe,
	it,
	expect,
	label: 'DiskSessionLog',
	contractVersion: 2,
	makeLog: async (sessionId) => {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-session-log-')))
		made.push(root)
		const file = join(root, `${sessionId}.jsonl`)
		const sessionDir = join(root, sessionId)
		const open = () => new DiskSessionLog({ sessionId, file, sessionDir })
		return {
			log: open(),
			reopen: open,
			tamper: {
				bytes: async () => new Uint8Array(await readFile(file)),
				overwrite: async (bytes) => writeFile(file, bytes),
			},
		}
	},
})
