import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { builtInDoctorChecks } from '../index.js'
import { describeStateFiles, stateFilesCheck } from '../state-files.js'

const dirs: string[] = []
function home(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-doctor-state-'))
	dirs.push(dir)
	return dir
}
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

describe('state files doctor line', () => {
	it('says where the recovery copies are kept, also before there are any', () => {
		const root = home()
		expect(describeStateFiles(root)).toEqual({
			status: 'pass',
			message: `state files readable. Recovery copies are kept in ${join(root, 'backups')} (none yet).`,
		})
		mkdirSync(join(root, 'backups'))
		writeFileSync(join(root, 'backups', 'config.yaml.backup.1'), '')
		writeFileSync(join(root, 'backups', 'trust.json.backup.2'), '')
		expect(describeStateFiles(root).message).toBe(
			`state files readable. Recovery copies: 2 in ${join(root, 'backups')} (config.yaml, trust.json).`,
		)
	})

	it('fails, naming the file and how to go back, when a list cannot be read', () => {
		const root = home()
		writeFileSync(join(root, 'trust.json'), '{ broken')
		mkdirSync(join(root, 'backups'))
		writeFileSync(join(root, 'backups', 'trust.json.corrupt-5'), '{ broken')
		const result = describeStateFiles(root)
		expect(result.status).toBe('fail')
		expect(result.message).toContain(
			`${join(root, 'trust.json')} could not be read (not valid JSON)`,
		)
		expect(result.message).toContain('1 of them kept from a file that could not be read')
		expect(result.remediation).toContain('copy the newest <file>.backup.<time>')
	})

	it('runs against the Namzu home the environment names, and is one of the built-in checks', async () => {
		const root = home()
		writeFileSync(join(root, 'mcp-approvals.json'), '[]')
		const result = await stateFilesCheck.run({
			cwd: root,
			env: { NAMZU_HOME: root },
			projectRoot: null,
		})
		expect(result.status).toBe('fail')
		expect(builtInDoctorChecks).toContain(stateFilesCheck)
	})
})
