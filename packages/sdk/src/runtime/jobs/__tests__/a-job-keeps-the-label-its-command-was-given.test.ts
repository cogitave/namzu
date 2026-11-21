import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { BackgroundJobRegistry, bindOwner } from '../registry.js'

/**
 * A command started with a short label keeps it on its record, so a host can name
 * the job for a person by what it is for rather than by its command line.
 */

const dirs: string[] = []
let base: string

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), 'namzu-job-label-'))
	dirs.push(base)
})
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

describe('a background command with a label', () => {
	it('carries it on the record, and is not a monitor', async () => {
		const registry = new BackgroundJobRegistry()
		const job = registry.start({
			owner: 'o',
			command: 'true',
			description: 'Run full test suite',
			workingDirectory: base,
		})
		await registry.waitForExit(job.id)
		const record = registry.get(job.id)
		expect(record.description).toBe('Run full test suite')
		expect(record.kind).toBeUndefined()
	})

	it('passes through the binding a tool is given', async () => {
		const registry = new BackgroundJobRegistry()
		const bound = bindOwner(registry, 'o', { workingDirectory: base })
		const job = bound.start({ command: 'true', description: 'Build the docs' })
		await registry.waitForExit(job.id)
		expect(registry.get(job.id).description).toBe('Build the docs')
	})

	it('has none when none was given', async () => {
		const registry = new BackgroundJobRegistry()
		const job = registry.start({ owner: 'o', command: 'true', workingDirectory: base })
		await registry.waitForExit(job.id)
		expect(registry.get(job.id).description).toBeUndefined()
	})
})
