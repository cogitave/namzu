import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
	EMA_MODEL_FILES,
	EMA_MODEL_REVISION,
	EMA_SOURCE_REVISION,
	LOCAL_SPEECH_WORKER_SOURCE,
} from './local-speech-assets.js'
import {
	LOCAL_SPEECH_WORKER_SHA256,
	type LocalSpeechInstallation,
	bundledLocalSpeechPython,
	copyVisualCRuntimeIntoTorch,
	installLocalSpeech,
	localSpeechContainsPath,
	localSpeechRuntimePaths,
	readLocalSpeechInstallation,
	windowsRuntimeRequirements,
} from './local-speech-install.js'
import { LocalSpeechInstallShutdownError } from './local-speech-process.js'

const directories: string[] = []
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true })
})
async function directory(): Promise<string> {
	const result = await mkdtemp(join(tmpdir(), 'namzu-speech-install-'))
	directories.push(result)
	return result
}
async function installedFixture() {
	const root = await directory()
	const receipt: LocalSpeechInstallation = {
		v: 1,
		modelRevision: EMA_MODEL_REVISION,
		sourceRevision: EMA_SOURCE_REVISION,
		engineVersion: '1.0.1',
		runtimeDirectory: 'runtime-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
		workerSha256: LOCAL_SPEECH_WORKER_SHA256,
		runtimeDownloadBytes: 150_000_000,
		diskBytes: 500_000_000,
		installedAt: '2026-10-07T00:00:00.000Z',
	}
	const paths = localSpeechRuntimePaths(root, receipt.runtimeDirectory)
	await mkdir(join(paths.runtime, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin'), {
		recursive: true,
	})
	await mkdir(paths.models)
	await writeFile(paths.python, 'fixture; never executed')
	await writeFile(paths.worker, LOCAL_SPEECH_WORKER_SOURCE)
	// Sparse placeholders exercise metadata inspection without downloading, loading or unpickling models.
	for (const model of EMA_MODEL_FILES) {
		const file = await open(join(paths.models, model.name), 'w')
		await file.truncate(model.bytes)
		await file.close()
	}
	await writeFile(join(root, 'installation.json'), JSON.stringify(receipt))
	return { root, receipt, paths }
}

it('inspects only the exact pinned worker and model metadata without launching Python or accessing the network', async () => {
	const { root, receipt } = await installedFixture()
	expect(await readLocalSpeechInstallation(root)).toEqual(receipt)
	const run = vi.fn()
	const network = vi.fn()
	expect(await installLocalSpeech({ directory: root, run, fetch: network })).toEqual(receipt)
	expect(run).not.toHaveBeenCalled()
	expect(network).not.toHaveBeenCalled()
})

it('refuses an altered worker or revision and does not execute an integrity-failed installation', async () => {
	const { root, receipt, paths } = await installedFixture()
	await writeFile(paths.worker, `${LOCAL_SPEECH_WORKER_SOURCE}\n# altered`)
	await expect(readLocalSpeechInstallation(root)).rejects.toThrow('integrity check failed')
	const run = vi.fn()
	await expect(installLocalSpeech({ directory: root, run })).rejects.toThrow(
		'integrity check failed',
	)
	expect(run).not.toHaveBeenCalled()
	await writeFile(
		join(root, 'installation.json'),
		JSON.stringify({ ...receipt, modelRevision: 'main' }),
	)
	await expect(readLocalSpeechInstallation(root)).rejects.toThrow(
		'Invalid local speech installation',
	)
})

it('rejects old Python before downloading or creating an installed runtime', async () => {
	const root = await directory()
	const run = vi.fn().mockResolvedValue(JSON.stringify({ major: 3, minor: 10 }))
	const network = vi.fn()
	await expect(
		installLocalSpeech({
			directory: root,
			python: { program: '/trusted/python', args: ['-3'] },
			run,
			fetch: network,
		}),
	).rejects.toThrow('Python 3.11–3.14')
	expect(run).toHaveBeenCalledTimes(1)
	expect(run.mock.calls[0]?.[0]).toBe('/trusted/python')
	expect(run.mock.calls[0]?.[1]).toContain('-I')
	expect(network).not.toHaveBeenCalled()
	await expect(readFile(join(root, 'installation.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('confines serialized runtime paths and rejects foreign or malformed receipt metrics', async () => {
	const root = await directory()
	for (const path of [
		'../foreign',
		'/absolute',
		'runtime-------------------------------------',
		'runtime-../',
	])
		expect(() => localSpeechRuntimePaths(root, path)).toThrow('Invalid local speech installation')
	expect(localSpeechContainsPath(root, join(root, 'runtime-one', 'worker.py'))).toBe(true)
	expect(localSpeechContainsPath(root, root)).toBe(false)
	expect(localSpeechContainsPath(root, join(root, '..', 'worker.py'))).toBe(false)
	const fixture = await installedFixture()
	await writeFile(
		join(fixture.root, 'installation.json'),
		JSON.stringify({ ...fixture.receipt, diskBytes: -1 }),
	)
	await expect(readLocalSpeechInstallation(fixture.root)).rejects.toThrow(
		'Invalid local speech installation',
	)
})

it('rolls back only the newly created failed runtime and preserves preferences and another existing runtime', async () => {
	const root = await directory()
	const previous = join(root, 'runtime-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
	await mkdir(previous)
	await writeFile(join(previous, 'keep.txt'), 'existing user installation')
	await writeFile(join(root, 'settings.json'), '{"enabled":false}')
	const run = vi.fn(async (_program: string, args: string[]) => {
		if (args.includes('-c')) return JSON.stringify({ major: 3, minor: 14 })
		const destination = args.at(-1)!
		await mkdir(join(destination, 'nested'), { recursive: true })
		await writeFile(join(destination, 'nested', 'temporary.txt'), 'created by this failed install')
		throw new Error('test installer failure')
	})
	await expect(
		installLocalSpeech({ directory: root, python: { program: '/trusted/python' }, run }),
	).rejects.toThrow('test installer failure')
	expect((await readdir(root)).sort()).toEqual([
		'runtime-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
		'settings.json',
	])
	expect(await readFile(join(previous, 'keep.txt'), 'utf8')).toBe('existing user installation')
	expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe('{"enabled":false}')
	await expect(readFile(join(root, 'installation.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses cleanup through an unexpected symlink and preserves the linked external file', async () => {
	const root = await directory()
	const external = await directory()
	await writeFile(join(external, 'keep.txt'), 'outside owned runtime')
	const run = vi.fn(async (_program: string, args: string[]) => {
		if (args.includes('-c')) return JSON.stringify({ major: 3, minor: 14 })
		const destination = args.at(-1)!
		await mkdir(destination)
		await symlink(
			external,
			join(destination, 'unexpected-link'),
			process.platform === 'win32' ? 'junction' : 'dir',
		)
		throw new Error('test installer failure')
	})
	await expect(
		installLocalSpeech({ directory: root, python: { program: '/trusted/python' }, run }),
	).rejects.toThrow('could not be safely removed')
	expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('outside owned runtime')
	expect((await readdir(root)).filter((name) => name.startsWith('runtime-'))).toHaveLength(1)
})

it('preserves the incomplete runtime when installer process closure is unconfirmed', async () => {
	const root = await directory()
	const failure = new LocalSpeechInstallShutdownError()
	const run = vi.fn(async (_program: string, args: string[]) => {
		if (args.includes('-c')) return JSON.stringify({ major: 3, minor: 14 })
		const destination = args.at(-1)!
		await mkdir(destination)
		await writeFile(join(destination, 'still-owned.txt'), 'a live process may still use this file')
		throw failure
	})
	await expect(
		installLocalSpeech({ directory: root, python: { program: '/trusted/python' }, run }),
	).rejects.toBe(failure)
	const runtimes = (await readdir(root)).filter((name) => name.startsWith('runtime-'))
	expect(runtimes).toHaveLength(1)
	expect(await readFile(join(root, runtimes[0]!, 'venv', 'still-owned.txt'), 'utf8')).toBe(
		'a live process may still use this file',
	)
	await expect(readFile(join(root, 'installation.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('prefers the interpreter bundled under resources and ignores a directory or a missing one', async () => {
	const resources = await directory()
	expect(await bundledLocalSpeechPython(resources, 'win32')).toBeUndefined()
	expect(await bundledLocalSpeechPython(undefined, 'win32')).toBeUndefined()
	await mkdir(join(resources, 'python', 'python.exe'), { recursive: true })
	expect(await bundledLocalSpeechPython(resources, 'win32')).toBeUndefined()
	const other = await directory()
	await mkdir(join(other, 'python'))
	await writeFile(join(other, 'python', 'python.exe'), 'fixture; never executed')
	expect(await bundledLocalSpeechPython(other, 'win32')).toEqual({
		program: join(other, 'python', 'python.exe'),
		args: [],
	})
	await mkdir(join(other, 'python', 'bin'))
	await writeFile(join(other, 'python', 'bin', 'python3'), 'fixture; never executed')
	expect(await bundledLocalSpeechPython(other, 'linux')).toEqual({
		program: join(other, 'python', 'bin', 'python3'),
		args: [],
	})
})

it('asks for the Visual C++ runtime wheel on Windows only, pinned', () => {
	expect(windowsRuntimeRequirements('win32')).toEqual(['msvc-runtime==14.44.35112'])
	expect(windowsRuntimeRequirements('linux')).toEqual([])
	expect(windowsRuntimeRequirements('darwin')).toEqual([])
})

it('copies only the runtime DLLs from the venv Scripts folder into torch lib', async () => {
	const venv = await mkdtemp(join(tmpdir(), 'namzu-vc-'))
	try {
		await mkdir(join(venv, 'Scripts'), { recursive: true })
		await mkdir(join(venv, 'Lib', 'site-packages', 'torch', 'lib'), { recursive: true })
		for (const name of [
			'msvcp140.dll',
			'vcruntime140_1.dll',
			'vcomp140.dll',
			'python.exe',
			'pip.exe',
		])
			await writeFile(join(venv, 'Scripts', name), name)
		expect(await copyVisualCRuntimeIntoTorch(venv)).toBe(3)
		expect((await readdir(join(venv, 'Lib', 'site-packages', 'torch', 'lib'))).sort()).toEqual([
			'msvcp140.dll',
			'vcomp140.dll',
			'vcruntime140_1.dll',
		])
		expect(await copyVisualCRuntimeIntoTorch(join(venv, 'missing'))).toBe(0)
	} finally {
		await rm(venv, { recursive: true, force: true })
	}
})
