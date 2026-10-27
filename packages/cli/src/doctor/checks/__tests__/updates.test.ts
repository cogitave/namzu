import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { scopeOf } from '../../../integrations/auto-update/apply.js'
import type { InstallKind } from '../../../integrations/auto-update/install-kind.js'
import { writeAttempt, writeCheck } from '../../../integrations/auto-update/state.js'
import { describeUpdates } from '../updates.js'

let home: string
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-doctor-updates-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const install = (writable: boolean): Extract<InstallKind, { kind: 'npm-global' }> => ({
	kind: 'npm-global',
	root: '/usr/lib/node_modules/@namzu/cli',
	prefix: '/usr',
	owned: false,
	writable,
})
const input = (kind: InstallKind) => ({
	currentVersion: '1.0.0',
	install: kind,
	home,
	platform: 'linux' as const,
})
const learn = (version: string) =>
	writeCheck(home, { at: 1, channel: 'latest', version, integrity: 'sha512-AAAA' })

describe('what doctor says about updates', () => {
	it('passes when no newer version is known', () => {
		expect(describeUpdates(input(install(true))).status).toBe('pass')
	})

	it('shows the full command and the reason when the install folder is not writable', () => {
		learn('2.0.0')
		const result = describeUpdates(input(install(false)))
		expect(result.status).toBe('warn')
		expect(result.message).toContain('cannot write to the folder it is installed in')
		expect(result.message).toContain('/usr')
		expect(result.remediation).toBe('Run: sudo npm install --global --prefix /usr @namzu/cli@2.0.0')
	})

	it('says a version that did not start stays unoffered, with no command', () => {
		learn('2.0.0')
		const kind = install(true)
		writeAttempt(home, scopeOf(kind, 'linux'), {
			version: '2.0.0',
			code: 'verify_failed',
			at: 1,
			shown: true,
		})
		const result = describeUpdates(input(kind))
		expect(result.status).toBe('warn')
		expect(result.message).toContain('did not work on this install')
		expect(result.message).toContain('stays on 1.0.0')
		expect(result.remediation).toBeUndefined()
	})

	it('offers the plain command for a writable install', () => {
		learn('2.0.0')
		expect(describeUpdates(input(install(true))).remediation).toBe('Run: namzu upgrade')
	})
})
