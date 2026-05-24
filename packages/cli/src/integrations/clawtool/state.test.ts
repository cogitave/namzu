import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { readDaemonState } from './state.js'

describe('readDaemonState', () => {
	it('returns null when the file is missing', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-state-'))
		expect(readDaemonState(join(dir, 'nope.json'))).toBeNull()
	})

	it('returns null on malformed JSON', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-state-'))
		const path = join(dir, 'daemon.json')
		writeFileSync(path, '{not json}')
		expect(readDaemonState(path)).toBeNull()
	})

	it('returns null when required fields are missing', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-state-'))
		const path = join(dir, 'daemon.json')
		writeFileSync(path, JSON.stringify({ pid: 1, port: 2 }))
		expect(readDaemonState(path)).toBeNull()
	})

	it('parses a valid state file', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-state-'))
		const path = join(dir, 'daemon.json')
		const state = {
			version: 1,
			pid: 1234,
			port: 65432,
			started_at: '2026-05-24T12:00:00Z',
			token_file: '/tmp/token',
			log_file: '/tmp/log',
		}
		writeFileSync(path, JSON.stringify(state))
		expect(readDaemonState(path)).toEqual(state)
	})
})
