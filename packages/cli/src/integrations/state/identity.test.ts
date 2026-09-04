import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { loadIdentity } from './identity.js'

let home: string

afterEach(() => {
	removeTempDir(home)
})

describe('the installation identity', () => {
	it('is minted once and read back the same afterwards', () => {
		home = mkdtempSync(join(tmpdir(), 'namzu-identity-'))
		const first = loadIdentity(home)
		expect(first.tenantId.startsWith('tnt_')).toBe(true)
		expect(loadIdentity(home).tenantId).toBe(first.tenantId)
		expect(JSON.parse(readFileSync(join(home, 'identity.json'), 'utf8')).tenantId).toBe(
			first.tenantId,
		)
	})

	it('refuses a file it cannot read rather than minting over it', () => {
		home = mkdtempSync(join(tmpdir(), 'namzu-identity-'))
		writeFileSync(join(home, 'identity.json'), '{not json')
		expect(() => loadIdentity(home)).toThrow(/identity file/)
	})
})
