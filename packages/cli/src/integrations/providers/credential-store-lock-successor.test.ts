/** Releasing one owner must never unlink a successor's canonical lock. */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const successor = vi.hoisted(() => ({
	injected: false,
	token: '999999:1:successor',
}))

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>()
	return {
		...actual,
		renameSync: (
			from: Parameters<typeof actual.renameSync>[0],
			to: Parameters<typeof actual.renameSync>[1],
		) => {
			actual.renameSync(from, to)
			if (!successor.injected && String(to).endsWith('credentials.json')) {
				successor.injected = true
				const lockPath = `${String(to)}.lock`
				actual.rmSync(lockPath, { force: true })
				actual.writeFileSync(lockPath, successor.token, { mode: 0o600 })
			}
		},
	}
})

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	credentialsPath,
	readStoredSubscriptionCredential,
	writeStoredSubscriptionCredential,
} from './credential-store.js'

const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

it('leaves a different owner token in place during release', () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-credential-lock-successor-'))
	roots.push(home)
	successor.injected = false
	const lockPath = `${credentialsPath(home)}.lock`

	expect(writeStoredSubscriptionCredential({ accessToken: 'first' }, home)).toBe(
		credentialsPath(home),
	)
	expect(successor.injected).toBe(true)
	expect(readFileSync(lockPath, 'utf8')).toBe(successor.token)

	// Simulate the successor completing and releasing its own lock. The next
	// writer must then acquire and release normally.
	rmSync(lockPath, { force: true })
	expect(writeStoredSubscriptionCredential({ accessToken: 'second' }, home)).toBe(
		credentialsPath(home),
	)
	expect(readStoredSubscriptionCredential(home)?.accessToken).toBe('second')
	expect(existsSync(lockPath)).toBe(false)
})
