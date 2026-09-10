import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fingerprintCli } from '../installation.js'

it('distinguishes executable changes without depending on location or sourcemaps', () => {
	const first = mkdtempSync(join(tmpdir(), 'namzu-install-a-'))
	const second = mkdtempSync(join(tmpdir(), 'namzu-install-b-'))
	try {
		for (const path of [first, second])
			writeFileSync(join(path, 'bin.js'), 'export const value = 1')
		writeFileSync(join(second, 'bin.js.map'), 'different build location')
		expect(fingerprintCli(first)).toBe(fingerprintCli(second))
		writeFileSync(join(second, 'bin.js'), 'export const value = 2')
		expect(fingerprintCli(first)).not.toBe(fingerprintCli(second))
	} finally {
		rmSync(first, { recursive: true, force: true })
		rmSync(second, { recursive: true, force: true })
	}
})
