/** Windows must secure the credential directory before creating a secret temp file. */

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const acl = vi.hoisted(() => ({
	events: [] as string[],
	rejectParent: false,
}))

vi.mock('node:os', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:os')>()),
	platform: () => 'win32' as const,
}))

vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>()
	const { writeFileSync } = await import('node:fs')
	return {
		...actual,
		execFileSync: (file: string, args: readonly string[]) => {
			if (file.endsWith('whoami.exe')) return '"runner","S-1-5-21-123"\r\n'
			if (!file.endsWith('icacls.exe')) throw new Error(`unexpected executable: ${file}`)
			const target = String(args[0] ?? '')
			if (args[1] === '/save') {
				const extraGrant = acl.rejectParent && target.endsWith('/.namzu') ? '(A;;FA;;;WD)' : ''
				writeFileSync(String(args[2]), `D:P(A;;FA;;;S-1-5-21-123)${extraGrant}`, 'utf16le')
				return ''
			}
			acl.events.push(`secure:${target}`)
			return ''
		},
	}
})

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>()
	return {
		...actual,
		openSync: (
			path: Parameters<typeof actual.openSync>[0],
			flags: Parameters<typeof actual.openSync>[1],
			mode?: number,
		) => {
			if (String(path).includes('gemini-api-key.json.lock.candidate.'))
				acl.events.push('open:lock-candidate')
			if (String(path).includes('gemini-api-key.json.tmp.')) acl.events.push('open:secret-temp')
			return actual.openSync(path, flags, mode)
		},
		writeSync: (fd: number, bytes: Buffer, offset?: number, length?: number) => {
			if (bytes.includes(Buffer.from('fixture-secret'))) acl.events.push('write:secret')
			return actual.writeSync(fd, bytes, offset, length)
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

afterEach(() => {
	acl.events.length = 0
	acl.rejectParent = false
	for (const home of homes.splice(0)) removeTempDir(home)
})

it('protects the Windows parent before the temp is created and written', () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-parent-privacy-'))
	homes.push(home)
	const path = googleApiKeyPath(home)
	writeStoredGeminiApiKey('fixture-secret', home)

	const parentProof = acl.events.indexOf(`secure:${dirname(path)}`)
	const lockOpen = acl.events.indexOf('open:lock-candidate')
	const tempOpen = acl.events.indexOf('open:secret-temp')
	const tempProof = acl.events.findIndex((event) => event.startsWith(`secure:${path}.tmp.`))
	const secretWrite = acl.events.indexOf('write:secret')
	expect(parentProof).toBeGreaterThanOrEqual(0)
	expect(lockOpen).toBeGreaterThan(parentProof)
	expect(tempOpen).toBeGreaterThan(lockOpen)
	expect(tempProof).toBeGreaterThan(tempOpen)
	expect(secretWrite).toBeGreaterThan(tempProof)
})

it('refuses a parent with another explicit reader before creating a secret temp', () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-parent-privacy-'))
	homes.push(home)
	const path = googleApiKeyPath(home)
	acl.rejectParent = true

	expect(() => writeStoredGeminiApiKey('fixture-secret', home)).toThrow(CredentialStoreError)
	expect(acl.events).toContain(`secure:${dirname(path)}`)
	expect(acl.events).not.toContain('open:lock-candidate')
	expect(acl.events).not.toContain('open:secret-temp')
	expect(acl.events).not.toContain('write:secret')
	expect(existsSync(path)).toBe(false)
})

it('refuses to read a saved key when its parent cannot be proven private', () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-parent-privacy-'))
	homes.push(home)
	const path = googleApiKeyPath(home)
	writeStoredGeminiApiKey('fixture-secret', home)
	acl.events.length = 0
	acl.rejectParent = true

	expect(readStoredGeminiApiKey(home)).toBeNull()
	expect(acl.events).toContain(`secure:${dirname(path)}`)
	expect(acl.events).not.toContain(`secure:${path}`)
})
