import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { shellLineEscalation } from './shell-line-escalation.js'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-line-escalation-')))
const host = { roots: [root], cwd: root, sandboxed: false }

describe('what a shell line reaches past the working folders', () => {
	it('lets a line that stays inside the roots through', async () => {
		expect(
			await shellLineEscalation('echo ok > inside.txt && cat inside.txt', host),
		).toBeUndefined()
	})

	it('stops a removal under the home folder', async () => {
		expect(await shellLineEscalation('rm -rf ~/namzu-never-there', host)).toBeDefined()
	})

	it('stops a write outside the roots on the host', async () => {
		expect(await shellLineEscalation('echo x > /etc/namzu-test-out', host)).toBeDefined()
	})

	it('does not look at outside paths in a sandbox, where they are the guest’s', async () => {
		expect(
			await shellLineEscalation('echo x > /tmp/namzu-test-out', { ...host, sandboxed: true }),
		).toBeUndefined()
	})
})
