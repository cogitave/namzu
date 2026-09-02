import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { LocalSandboxProvider } from '../provider/local.js'

/**
 * Real bwrap, when the machine has it: a detached process runs under the
 * same mounts as `exec`, its output arrives on the pipes, and the
 * sandbox's kill ends it — inner reaper included — within the grace.
 */

let root: string
const provider = new LocalSandboxProvider(NOOP_LOGGER)
const bwrap = provider.environment === 'linux-bwrap'

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'namzu-detached-'))
	await writeFile(join(root, 'marker.txt'), 'inside the root')
})

afterEach(async () => {
	await rm(root, { recursive: true, force: true })
})

describe.skipIf(!bwrap)('a detached process in the local sandbox', () => {
	it('sees the root, writes to the pipes, and dies when killed', async () => {
		const sandbox = await provider.create({ workingDirectory: root })
		const started = sandbox.spawnDetached?.('/bin/sh', ['-c', 'cat marker.txt; sleep 30'])
		expect(started).toBeDefined()
		if (!started) return
		let out = ''
		started.child.stdout?.on('data', (chunk: Buffer) => {
			out += chunk.toString('utf8')
		})
		await new Promise((r) => setTimeout(r, 1500))
		expect(out).toContain('inside the root')
		const exited = new Promise<void>((resolve) => started.child.once('close', () => resolve()))
		const at = Date.now()
		started.kill('SIGTERM')
		await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))])
		expect(started.child.exitCode !== null || started.child.signalCode !== null).toBe(true)
		expect(Date.now() - at).toBeLessThan(8000)
		await sandbox.destroy()
	}, 20_000)
})
