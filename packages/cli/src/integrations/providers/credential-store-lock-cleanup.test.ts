/** Candidate cleanup failure must not leak an already-acquired canonical lock. */

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const cleanupFault = vi.hoisted(() => ({ injected: false }))

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>()
	return {
		...actual,
		rmSync: (
			path: Parameters<typeof actual.rmSync>[0],
			options?: Parameters<typeof actual.rmSync>[1],
		) => {
			if (!cleanupFault.injected && String(path).includes('.lock.candidate.')) {
				cleanupFault.injected = true
				throw Object.assign(new Error('candidate is temporarily share-locked'), { code: 'EBUSY' })
			}
			return actual.rmSync(path, options)
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

it('releases the canonical owner when candidate cleanup fails after link', () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-credential-lock-cleanup-'))
	roots.push(home)
	cleanupFault.injected = false

	expect(writeStoredSubscriptionCredential({ accessToken: 'first' }, home)).toBe(
		credentialsPath(home),
	)
	expect(cleanupFault.injected).toBe(true)
	expect(existsSync(`${credentialsPath(home)}.lock`)).toBe(false)
	expect(writeStoredSubscriptionCredential({ accessToken: 'second' }, home)).toBe(
		credentialsPath(home),
	)
	expect(readStoredSubscriptionCredential(home)?.accessToken).toBe('second')
})
