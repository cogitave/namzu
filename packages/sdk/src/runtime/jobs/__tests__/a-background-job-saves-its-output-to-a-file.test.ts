import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { BackgroundJobRegistry } from '../registry.js'

/**
 * A model that runs a long build in the background used to have no file to
 * read: the output lived in a 1 MiB memory tail, so the model redirected it
 * into a log of its own in the working directory. The registry now writes every
 * job's output to a file in a folder the host names, and says where it is.
 */

const dirs: string[] = []
let base: string

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), 'namzu-job-output-'))
	dirs.push(base)
})
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

describe('a background job with an output folder', () => {
	it('writes what it prints to <folder>/<id>.log and puts the path on its record', async () => {
		const registry = new BackgroundJobRegistry()
		const folder = join(base, 'scratch', 'jobs')
		const job = registry.start({
			owner: 'o',
			command: 'printf "one\\ntwo\\n"',
			workingDirectory: base,
			outputDirectory: folder,
		})
		await registry.waitForExit(job.id)
		expect(job.outputFile).toBe(join(folder, `${job.id}.log`))
		expect(registry.get(job.id).outputFile).toBe(job.outputFile)
		expect(await readFile(job.outputFile as string, 'utf8')).toBe('one\ntwo\n')
		// The live tail the views read is still there.
		expect(registry.read(job.id).chunk).toBe('one\ntwo\n')
	})

	it('keeps output past the in-memory cap, which the file is for', async () => {
		const registry = new BackgroundJobRegistry({ maxOutputBytesPerJob: 16 })
		const job = registry.start({
			owner: 'o',
			command: 'i=0; while [ $i -lt 200 ]; do echo line-$i; i=$((i+1)); done',
			workingDirectory: base,
			outputDirectory: join(base, 'jobs'),
		})
		await registry.waitForExit(job.id)
		const whole = await readFile(job.outputFile as string, 'utf8')
		expect(whole.split('\n')).toContain('line-0')
		expect(whole.split('\n')).toContain('line-199')
		expect(registry.read(job.id).droppedBytes).toBeGreaterThan(0)
	})

	it.skipIf(process.platform === 'win32')(
		'is private to the owner: folder 0700, file 0600',
		async () => {
			const registry = new BackgroundJobRegistry()
			const folder = join(base, 'jobs')
			const job = registry.start({
				owner: 'o',
				command: 'true',
				workingDirectory: base,
				outputDirectory: folder,
			})
			await registry.waitForExit(job.id)
			expect((await stat(folder)).mode & 0o777).toBe(0o700)
			expect((await stat(job.outputFile as string)).mode & 0o777).toBe(0o600)
		},
	)

	it('runs without a file, and without a path, when the folder cannot be made', async () => {
		const registry = new BackgroundJobRegistry()
		const blocker = join(base, 'a-file')
		await writeFile(blocker, 'x')
		const job = registry.start({
			owner: 'o',
			command: 'printf alive',
			workingDirectory: base,
			outputDirectory: join(blocker, 'jobs'),
		})
		await registry.waitForExit(job.id)
		expect(job.outputFile).toBeUndefined()
		expect(registry.read(job.id).chunk).toBe('alive')
	})
})

describe('a background job without an output folder', () => {
	it('keeps its output in memory only and has no path to report', async () => {
		const registry = new BackgroundJobRegistry()
		const job = registry.start({ owner: 'o', command: 'printf x', workingDirectory: base })
		await registry.waitForExit(job.id)
		expect(job.outputFile).toBeUndefined()
	})
})
