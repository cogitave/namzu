import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { LocalSandboxProvider } from '../provider/local.js'

/**
 * Real bwrap, when the machine has it: a detached process runs under the
 * same mounts as `exec`, its output arrives on the pipes, and the
 * sandbox's kill ends it — inner reaper included.
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
		// Resolves when the marker's text has arrived on the pipe: an event,
		// not a guess at how long a bwrap spawn takes. A process that never
		// prints is a hang the case's own Vitest timeout reports.
		const sawMarker = new Promise<void>((resolve) => {
			started.child.stdout?.on('data', (chunk: Buffer) => {
				out += chunk.toString('utf8')
				if (out.includes('inside the root')) resolve()
			})
		})
		await sawMarker
		expect(out).toContain('inside the root')
		const exited = new Promise<void>((resolve) => started.child.once('close', () => resolve()))
		started.kill('SIGTERM')
		// Awaited outright, with no sentinel racing it and no bound on how
		// long it takes: the process sleeps 30s, so a kill that did not land
		// shows as the Vitest timeout, not as a slow machine.
		await exited
		expect(started.child.exitCode !== null || started.child.signalCode !== null).toBe(true)
		await sandbox.destroy()
	}, 20_000)
})
