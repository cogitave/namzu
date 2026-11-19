import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { removeTree } from './store.js'

it('removes an installed version whose folders and files were made read-only', () => {
	const root = mkdtempSync(join(tmpdir(), 'nz-remove-'))
	const version = join(root, 'versions', '0.2.0')
	mkdirSync(join(version, 'bin'), { recursive: true })
	writeFileSync(join(version, 'bin', 'namzu-activity.exe'), 'x')
	writeFileSync(join(version, 'manifest.json'), '{}')
	chmodSync(join(version, 'bin', 'namzu-activity.exe'), 0o444)
	chmodSync(join(version, 'manifest.json'), 0o444)
	chmodSync(join(version, 'bin'), 0o555)
	chmodSync(version, 0o555)
	removeTree(join(root, 'versions'))
	expect(existsSync(join(root, 'versions'))).toBe(false)
})
