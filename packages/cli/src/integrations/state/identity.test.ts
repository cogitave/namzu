import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isEntityId } from '@namzu/sdk'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { loadIdentity, readIdentity } from './identity.js'

let home: string

afterEach(() => {
	removeTempDir(home)
})

describe('the installation identity', () => {
	it('is minted once and read back the same afterwards', () => {
		home = mkdtempSync(join(tmpdir(), 'namzu-identity-'))
		const first = loadIdentity(home)
		expect(isEntityId(first.tenantId, 'tenant')).toBe(true)
		expect(loadIdentity(home).tenantId).toBe(first.tenantId)
		expect(JSON.parse(readFileSync(join(home, 'identity.json'), 'utf8')).tenantId).toBe(
			first.tenantId,
		)
	})

	it('reports absence without creating state during a read-only inventory', () => {
		home = mkdtempSync(join(tmpdir(), 'namzu-identity-'))
		expect(readIdentity(home)).toBeNull()
		expect(existsSync(join(home, 'identity.json'))).toBe(false)
	})

	it.skipIf(process.platform === 'win32')('publishes an owner-only identity file', () => {
		home = mkdtempSync(join(tmpdir(), 'namzu-identity-'))
		loadIdentity(home)
		expect(statSync(join(home, 'identity.json')).mode & 0o777).toBe(0o600)
	})

	it.each(['{not json', '{}', 'null', '[]', '{"tenantId":42}', '{"tenantId":"invalid"}'])(
		'refuses an invalid identity without replacing it: %s',
		(contents) => {
			home = mkdtempSync(join(tmpdir(), 'namzu-identity-'))
			const path = join(home, 'identity.json')
			writeFileSync(path, contents)
			expect(() => readIdentity(home)).toThrow(/identity file/)
			expect(() => loadIdentity(home)).toThrow(/identity file/)
			expect(readFileSync(path, 'utf8')).toBe(contents)
		},
	)
})
