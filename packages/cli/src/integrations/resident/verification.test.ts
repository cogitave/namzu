import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateTurnId } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadResidentVerification, residentClaimVerifier } from './verification.js'

let cwd: string
let root: string
const spec = {
	version: 1 as const,
	claims: [{ id: 'version', source: 'package.json', pointer: '/version' }],
}
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'namzu-verification-'))
	cwd = join(root, 'workspace')
	await mkdir(cwd)
})
afterEach(async () => {
	await rm(root, { recursive: true, force: true })
})

describe('resident verification host reads', () => {
	it('loads a bounded immutable policy and observes changes without cached success', async () => {
		await writeFile(join(cwd, 'checks.json'), JSON.stringify(spec))
		await writeFile(join(cwd, 'package.json'), '{"version":"3"}')
		const turnId = generateTurnId()
		const policy = await loadResidentVerification('checks.json', cwd)
		const check = residentClaimVerifier(policy, cwd, 'claim A', turnId)
		await writeFile(join(cwd, 'checks.json'), '{"version":999}')
		expect((await check.verify({ version: '3' }, { turnId, iteration: 1 })).accept).toBe(true)
		await writeFile(join(cwd, 'package.json'), '{"version":"4"}')
		expect((await check.verify({ version: '3' }, { turnId, iteration: 2 })).accept).toBe(false)
		expect((await check.verify({ version: '4' }, { turnId, iteration: 3 })).accept).toBe(true)
	})
	it('rejects missing sources and links outside the workspace', async () => {
		const turnId = generateTurnId()
		const check = residentClaimVerifier(spec, cwd, 'claim A', turnId)
		expect((await check.verify({ version: '3' }, { turnId, iteration: 1 })).accept).toBe(false)
		await writeFile(join(root, 'outside.json'), '{"version":"3"}')
		await symlink(root, join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
		const escaped = residentClaimVerifier(
			{ version: 1, claims: [{ ...spec.claims[0], source: 'escape/outside.json' }] },
			cwd,
			'claim A',
			turnId,
		)
		expect((await escaped.verify({ version: '3' }, { turnId, iteration: 2 })).accept).toBe(false)
	})
	it.each(['../secret.json', '/secret.json', 'a/../secret.json', 'a\\secret.json'])(
		'rejects an unauthorized source before observations: %s',
		(source) => {
			expect(() =>
				residentClaimVerifier(
					{ version: 1, claims: [{ ...spec.claims[0], source }] },
					cwd,
					'scope',
					generateTurnId(),
				),
			).toThrow()
		},
	)
	it('rejects oversized policy and invalid fields before model admission', async () => {
		await writeFile(join(cwd, 'checks.json'), ' '.repeat(65_536))
		await expect(loadResidentVerification('checks.json', cwd)).rejects.toThrow('bounded')
		await writeFile(join(cwd, 'checks.json'), JSON.stringify({ ...spec, unexpected: true }))
		await expect(loadResidentVerification('checks.json', cwd)).rejects.toThrow()
	})
})
