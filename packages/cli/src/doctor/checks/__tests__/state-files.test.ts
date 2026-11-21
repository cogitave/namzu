import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
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
		writeFileSync(join(root, 'backups', 'trust.json.corrupted.5'), '{ broken')
		const result = describeStateFiles(root)
		expect(result.status).toBe('fail')
		expect(result.message).toContain(
			`${join(root, 'trust.json')} could not be read (not valid JSON)`,
		)
		expect(result.message).toContain('1 of them kept from a file that could not be read')
		expect(result.remediation).toContain('copy the newest <file>.backup.<time>')
		expect(result.remediation).toContain('that change and any later one are not in it')
		expect(result.remediation).toContain('answer s in the trust box')
	})

	it('names a lock left by an exited process or never given an owner, and passes over a live one', () => {
		const root = home()
		writeFileSync(join(root, 'trust.json.lock'), `${2 ** 22 + 77}:0:gone`)
		writeFileSync(join(root, 'config.yaml.lock'), '')
		const old = (Date.now() - 60_000) / 1000
		utimesSync(join(root, 'config.yaml.lock'), old, old)
		writeFileSync(join(root, 'hint-counts.json.lock'), `${process.ppid}:0:live`)
		const result = describeStateFiles(root)
		expect(result.status).toBe('warn')
		expect(result.message).toContain(
			`${join(root, 'trust.json.lock')} was left by a process that has exited (pid ${2 ** 22 + 77}); the next change to its file takes it over`,
		)
		expect(result.message).toContain(`${join(root, 'config.yaml.lock')} was never given an owner`)
		expect(result.message).not.toContain('hint-counts.json.lock')
	})

	it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
		'fails on a lock that cannot be read, since nothing can take it over',
		() => {
			const root = home()
			writeFileSync(join(root, 'trust.json.lock'), `${process.ppid}:0:live`)
			chmodSync(join(root, 'trust.json.lock'), 0o000)
			const result = describeStateFiles(root)
			chmodSync(join(root, 'trust.json.lock'), 0o600)
			expect(result.status).toBe('fail')
			expect(result.message).toContain(
				`${join(root, 'trust.json.lock')} could not be read (EACCES)`,
			)
			expect(result.remediation).toContain('remove it')
		},
	)

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
