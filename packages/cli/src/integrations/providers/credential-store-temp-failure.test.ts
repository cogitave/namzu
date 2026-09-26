/** A failed permission proof or close must never strand a secret in a temp file. */

import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({
	phase: 'none' as 'none' | 'precheck' | 'close' | 'short' | 'zero',
	tempFd: null as number | null,
	wroteSecret: false,
	writes: 0,
}))

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>()
	return {
		...actual,
		openSync: (path: Parameters<typeof actual.openSync>[0], flags: string, mode?: number) => {
			const fd = actual.openSync(path, flags, mode)
			if (String(path).includes('gemini-api-key.json.tmp.')) fault.tempFd = fd
			return fd
		},
		statSync: (path: Parameters<typeof actual.statSync>[0]) => {
			if (fault.phase === 'precheck' && String(path).includes('gemini-api-key.json.tmp.')) {
				throw new Error('permission proof failed')
			}
			return actual.statSync(path)
		},
		writeSync: (fd: number, body: Buffer, offset: number, length: number) => {
			if (fd === fault.tempFd) fault.wroteSecret = true
			if (fd === fault.tempFd) {
				fault.writes += 1
				if (fault.phase === 'zero') return 0
				if (fault.phase === 'short' && fault.writes === 1) {
					return actual.writeSync(fd, body, offset, Math.max(1, Math.floor(length / 2)))
				}
			}
			return actual.writeSync(fd, body, offset, length)
		},
		closeSync: (fd: number) => {
			actual.closeSync(fd)
			if (fd !== fault.tempFd) return
			fault.tempFd = null
			if (fault.phase === 'close') {
				fault.phase = 'none'
				throw new Error('close flush failed')
			}
		},
	}
})

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	CredentialStoreError,
	googleApiKeyPath,
	readStoredGeminiApiKey,
	writeStoredGeminiApiKey,
} from './credential-store.js'

const homes: string[] = []
const home = () => {
	const path = mkdtempSync(join(tmpdir(), 'namzu-temp-failure-'))
	homes.push(path)
	return path
}
const temporaryNames = (path: string) =>
	readdirSync(dirname(path)).filter((name) => name.startsWith('gemini-api-key.json.tmp.'))

afterEach(() => {
	fault.phase = 'none'
	fault.tempFd = null
	fault.wroteSecret = false
	fault.writes = 0
	for (const path of homes.splice(0)) removeTempDir(path)
})

it('proves the empty file private before any secret bytes are written', () => {
	const targetHome = home()
	const path = googleApiKeyPath(targetHome)
	fault.phase = 'precheck'
	expect(() => writeStoredGeminiApiKey('never-written-secret', targetHome)).toThrow(
		CredentialStoreError,
	)
	expect(fault.wroteSecret).toBe(false)
	expect(temporaryNames(path)).toEqual([])
	expect(readStoredGeminiApiKey(targetHome)).toBeNull()
})

it('removes the just-written temp when close reports a writeback failure', () => {
	const targetHome = home()
	const path = writeStoredGeminiApiKey('original-secret', targetHome)
	fault.wroteSecret = false
	fault.phase = 'close'
	expect(() => writeStoredGeminiApiKey('new-secret', targetHome)).toThrow(CredentialStoreError)
	expect(fault.wroteSecret).toBe(true)
	expect(temporaryNames(path)).toEqual([])
	expect(readStoredGeminiApiKey(targetHome)).toBe('original-secret')
})

it('finishes a short write before publishing the credential', () => {
	const targetHome = home()
	fault.phase = 'short'
	const path = writeStoredGeminiApiKey('new-🔑-secret', targetHome)
	expect(fault.writes).toBeGreaterThan(1)
	expect(temporaryNames(path)).toEqual([])
	expect(readStoredGeminiApiKey(targetHome)).toBe('new-🔑-secret')
})

it('keeps the old credential and removes the temp if a write makes no progress', () => {
	const targetHome = home()
	const path = writeStoredGeminiApiKey('original-secret', targetHome)
	fault.writes = 0
	fault.phase = 'zero'
	expect(() => writeStoredGeminiApiKey('new-secret', targetHome)).toThrow(CredentialStoreError)
	expect(fault.writes).toBe(1)
	expect(temporaryNames(path)).toEqual([])
	expect(readStoredGeminiApiKey(targetHome)).toBe('original-secret')
})
