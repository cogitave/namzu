import { createHash, randomUUID } from 'node:crypto'
import {
	copyFile,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	rmdir,
	unlink,
	writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
	EMA_MODEL_FILES,
	EMA_MODEL_REVISION,
	EMA_SOURCE_REVISION,
	EMA_WHEEL_SHA256,
	EMA_WHEEL_URL,
	LOCAL_SPEECH_WORKER_SOURCE,
} from './local-speech-assets.js'
import {
	LocalSpeechInstallShutdownError,
	LocalSpeechInstallerProcesses,
} from './local-speech-process.js'

export interface LocalSpeechPython {
	program: string
	args?: string[]
}
export interface LocalSpeechInstallation {
	v: 1
	modelRevision: string
	sourceRevision: string
	engineVersion: '1.0.1'
	runtimeDirectory: string
	workerSha256: string
	runtimeDownloadBytes: number
	diskBytes: number
	installedAt: string
}
export interface LocalSpeechInstallOptions {
	directory: string
	python?: LocalSpeechPython
	signal?: AbortSignal
	/** Test seam, never accepted from a renderer. */
	run?: typeof runLocalSpeechCommand
	fetch?: typeof fetch
}

export const LOCAL_SPEECH_WORKER_SHA256 = createHash('sha256')
	.update(LOCAL_SPEECH_WORKER_SOURCE)
	.digest('hex')

export function localSpeechRuntimePaths(directory: string, runtimeDirectory: string) {
	if (!/^runtime-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runtimeDirectory))
		throw new Error('Invalid local speech installation.')
	const runtime = join(directory, runtimeDirectory)
	return {
		runtime,
		python: join(
			runtime,
			'venv',
			process.platform === 'win32' ? 'Scripts' : 'bin',
			`python${process.platform === 'win32' ? '.exe' : ''}`,
		),
		worker: join(runtime, 'worker.py'),
		models: join(runtime, 'models'),
	}
}

/** Subprocess arguments are fixed by the installer; shell interpolation is never involved. */
const standaloneInstallerProcesses = new LocalSpeechInstallerProcesses()
export function runLocalSpeechCommand(
	program: string,
	args: string[],
	options: { cwd: string; signal?: AbortSignal },
): Promise<string> {
	return standaloneInstallerProcesses.run(program, args, options)
}

async function sha256File(path: string): Promise<string> {
	const file = await open(path, 'r')
	const hash = createHash('sha256')
	try {
		for await (const data of file.createReadStream({ autoClose: false })) hash.update(data)
	} finally {
		await file.close()
	}
	return hash.digest('hex')
}

async function verifyRegularFile(path: string, bytes?: number, sha256?: string): Promise<void> {
	const metadata = await lstat(path)
	if (
		!metadata.isFile() ||
		metadata.isSymbolicLink() ||
		(bytes !== undefined && metadata.size !== bytes)
	)
		throw new Error('Local speech installation integrity check failed.')
	if (sha256 !== undefined && (await sha256File(path)) !== sha256)
		throw new Error('Local speech installation integrity check failed.')
}

/** No subprocess, model loading or network access when reading the installed state. */
export async function readLocalSpeechInstallation(
	directory: string,
): Promise<LocalSpeechInstallation | undefined> {
	let record: unknown
	try {
		const raw = await readFile(join(directory, 'installation.json'), 'utf8')
		if (raw.length > 8_192) throw new Error('Invalid local speech installation.')
		record = JSON.parse(raw)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
	if (!record || typeof record !== 'object') throw new Error('Invalid local speech installation.')
	const value = record as LocalSpeechInstallation
	if (
		value.v !== 1 ||
		value.modelRevision !== EMA_MODEL_REVISION ||
		value.sourceRevision !== EMA_SOURCE_REVISION ||
		value.engineVersion !== '1.0.1' ||
		value.workerSha256 !== LOCAL_SPEECH_WORKER_SHA256 ||
		!Number.isSafeInteger(value.runtimeDownloadBytes) ||
		value.runtimeDownloadBytes < 0 ||
		!Number.isSafeInteger(value.diskBytes) ||
		value.diskBytes < 0 ||
		typeof value.installedAt !== 'string'
	)
		throw new Error('Invalid local speech installation.')
	const paths = localSpeechRuntimePaths(directory, value.runtimeDirectory)
	await verifyRegularFile(paths.python)
	await verifyRegularFile(paths.worker, undefined, LOCAL_SPEECH_WORKER_SHA256)
	// Model hashing is repeated by the worker before restricted tensor loading; state only checks sizes.
	for (const model of EMA_MODEL_FILES)
		await verifyRegularFile(join(paths.models, model.name), model.bytes)
	return value
}

async function treeBytes(root: string): Promise<number> {
	let bytes = 0
	let count = 0
	const walk = async (directory: string): Promise<void> => {
		for (const name of await readdir(directory)) {
			if (++count > 100_000) throw new Error('Local speech installation is too large.')
			const path = join(directory, name)
			const stat = await lstat(path)
			if (stat.isSymbolicLink()) continue
			if (stat.isDirectory()) await walk(path)
			else if (stat.isFile()) bytes += stat.size
		}
	}
	await walk(root)
	return bytes
}

async function downloadModel(
	model: (typeof EMA_MODEL_FILES)[number],
	path: string,
	options: LocalSpeechInstallOptions,
): Promise<void> {
	let response: Response
	try {
		response = await (options.fetch ?? fetch)(
			`https://huggingface.co/canberkkkkkk/ema-lightning/resolve/${EMA_MODEL_REVISION}/${model.name}`,
			{ signal: options.signal },
		)
	} catch {
		throw new Error('Local speech model download failed. Check the connection and try again.')
	}
	if (!response.ok || !response.body) throw new Error('Local speech model download failed.')
	const file = await open(path, 'wx', 0o600)
	const hash = createHash('sha256')
	let bytes = 0
	const reader = response.body.getReader()
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			bytes += value.byteLength
			if (bytes > model.bytes) throw new Error('Local speech model integrity check failed.')
			hash.update(value)
			await file.writeFile(value)
		}
		if (bytes !== model.bytes || hash.digest('hex') !== model.sha256)
			throw new Error('Local speech model integrity check failed.')
	} catch (error) {
		if (error instanceof Error && error.message === 'Local speech model integrity check failed.')
			throw error
		throw new Error('Local speech model download failed. Check the connection and try again.')
	} finally {
		await reader.cancel().catch(() => undefined)
		reader.releaseLock()
		await file.close()
	}
}

/** Only the runtime mkdir-created by this invocation, with its exact private ownership token. */
async function rollbackRuntime(
	directory: string,
	runtimeDirectory: string,
	token: string,
): Promise<void> {
	const { runtime } = localSpeechRuntimePaths(directory, runtimeDirectory)
	const metadata = await lstat(runtime)
	if (
		!metadata.isDirectory() ||
		metadata.isSymbolicLink() ||
		relative(await realpath(directory), await realpath(runtime)) !== runtimeDirectory
	)
		throw new Error('Local speech cleanup ownership check failed.')
	const marker = join(runtime, '.install-owner')
	const markerStat = await lstat(marker)
	if (
		!markerStat.isFile() ||
		markerStat.isSymbolicLink() ||
		markerStat.size !== token.length ||
		(await readFile(marker, 'utf8')) !== token
	)
		throw new Error('Local speech cleanup ownership check failed.')
	let count = 0
	const entries: { path: string; directory: boolean }[] = []
	const inspect = async (path: string, depth: number): Promise<void> => {
		if (depth > 32) throw new Error('Local speech cleanup exceeded its limit.')
		if (path !== runtime && !localSpeechContainsPath(runtime, await realpath(path)))
			throw new Error('Local speech cleanup refused a foreign directory.')
		for (const name of await readdir(path)) {
			const child = join(path, name)
			if (child === marker) continue
			if (++count > 100_000) throw new Error('Local speech cleanup exceeded its limit.')
			const stat = await lstat(child)
			if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
				throw new Error('Local speech cleanup refused an unexpected filesystem entry.')
			if (stat.isDirectory()) await inspect(child, depth + 1)
			entries.push({ path: child, directory: stat.isDirectory() })
		}
	}
	await inspect(runtime, 0)
	for (const entry of entries) {
		const stat = await lstat(entry.path)
		if (
			stat.isSymbolicLink() ||
			stat.isDirectory() !== entry.directory ||
			!localSpeechContainsPath(runtime, await realpath(entry.path))
		)
			throw new Error('Local speech cleanup refused a changed filesystem entry.')
		if (entry.directory) await rmdir(entry.path)
		else await unlink(entry.path)
	}
	await unlink(marker)
	await rmdir(runtime)
}

/**
 * The CPython that ships inside the installed app, under `<resources>/python`. It is a
 * python-build-standalone build with venv and pip, so speech needs nothing from the machine.
 * Only a regular file counts: a missing, linked or foreign entry falls through to the lookup.
 */
export async function bundledLocalSpeechPython(
	resourcesPath: string | undefined = (process as { resourcesPath?: string }).resourcesPath,
	platform: NodeJS.Platform = process.platform,
): Promise<LocalSpeechPython | undefined> {
	if (!resourcesPath) return undefined
	const interpreter =
		platform === 'win32'
			? join(resourcesPath, 'python', 'python.exe')
			: join(resourcesPath, 'python', 'bin', 'python3')
	try {
		if ((await lstat(interpreter)).isFile()) return { program: interpreter, args: [] }
	} catch {
		/* Not bundled in this build; the existing lookup follows. */
	}
	return undefined
}

async function defaultPython(): Promise<LocalSpeechPython> {
	const bundled = await bundledLocalSpeechPython()
	if (bundled) return bundled
	if (process.platform !== 'win32') return { program: 'python3', args: [] }
	const nativeData = process.env.LOCALAPPDATA
	if (nativeData) {
		const installed = join(nativeData, 'Python', 'bin', 'python.exe')
		try {
			if ((await lstat(installed)).isFile()) return { program: installed, args: [] }
		} catch {
			/* PATH fallback below. */
		}
	}
	return { program: 'python.exe', args: [] }
}

/** The pinned Visual C++ runtime wheel torch needs on Windows; nothing elsewhere. */
export function windowsRuntimeRequirements(platform: NodeJS.Platform): string[] {
	return platform === 'win32' ? ['msvc-runtime==14.44.35112'] : []
}

const VC_RUNTIME_DLL = /^(?:msvcp|vcruntime|vcomp|concrt|vcamp|vccorlib)\d[\w]*\.dll$/i

/**
 * Copies the Visual C++ runtime DLLs that `msvc-runtime` left in the venv's Scripts folder into
 * torch's own `lib` folder. The venv's python.exe is a launcher for the bundled interpreter, so
 * the Scripts folder is not on its DLL search path, while torch loads `c10.dll` with the search
 * set to its own folder. Verified on a clean Windows image: the wheel alone leaves `import torch`
 * failing with WinError 126, and this copy makes it load. A no-op where there is nothing to copy.
 */
export async function copyVisualCRuntimeIntoTorch(venv: string): Promise<number> {
	const scripts = join(venv, 'Scripts')
	const target = join(venv, 'Lib', 'site-packages', 'torch', 'lib')
	let names: string[]
	try {
		names = (await readdir(scripts)).filter((name) => VC_RUNTIME_DLL.test(name))
		if (!(await lstat(target)).isDirectory()) return 0
	} catch {
		return 0
	}
	let copied = 0
	for (const name of names) {
		if (!(await lstat(join(scripts, name))).isFile()) continue
		await copyFile(join(scripts, name), join(target, name))
		copied += 1
	}
	return copied
}

/** Explicit user action only. Nothing here runs at app startup or when merely enabling speech. */
export async function installLocalSpeech(
	options: LocalSpeechInstallOptions,
): Promise<LocalSpeechInstallation> {
	const directory = resolve(options.directory)
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const existing = await readLocalSpeechInstallation(directory)
	if (existing) return existing
	const python = options.python ?? (await defaultPython())
	const run = options.run ?? runLocalSpeechCommand
	const metadata = JSON.parse(
		await run(
			python.program,
			[
				...(python.args ?? []),
				'-I',
				'-c',
				'import json,sys; print(json.dumps({"major":sys.version_info.major,"minor":sys.version_info.minor}))',
			],
			{ cwd: directory, signal: options.signal },
		),
	) as { major?: number; minor?: number }
	if (metadata.major !== 3 || !metadata.minor || metadata.minor < 11 || metadata.minor > 14)
		throw new Error('Local speech needs Python 3.11–3.14. Install Python, then try again.')
	const runtimeDirectory = `runtime-${randomUUID()}`
	const paths = localSpeechRuntimePaths(directory, runtimeDirectory)
	const wheels = join(paths.runtime, 'wheels')
	await mkdir(paths.runtime, { mode: 0o700 })
	const ownershipToken = randomUUID()
	await writeFile(join(paths.runtime, '.install-owner'), ownershipToken, {
		flag: 'wx',
		mode: 0o600,
	})
	try {
		await mkdir(paths.models, { mode: 0o700 })
		await mkdir(wheels, { mode: 0o700 })
		await writeFile(paths.worker, LOCAL_SPEECH_WORKER_SOURCE, { flag: 'wx', mode: 0o600 })
		await run(
			python.program,
			[...(python.args ?? []), '-I', '-m', 'venv', '--copies', join(paths.runtime, 'venv')],
			{ cwd: directory, signal: options.signal },
		)
		const cpuWheel = process.platform !== 'darwin'
		const torch = cpuWheel ? 'torch==2.14.1+cpu' : 'torch==2.14.1'
		const numpy = metadata.minor === 11 ? 'numpy==2.3.5' : 'numpy==2.5.3'
		// A clean Windows machine has no Visual C++ runtime, and torch then fails to load c10.dll.
		// msvc-runtime puts the DLLs beside the venv's python.exe, so nothing is installed system-wide.
		const runtimeDlls = windowsRuntimeRequirements(process.platform)
		const pip = ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check']
		await run(
			paths.python,
			[
				...pip,
				'download',
				'--only-binary=:all:',
				'--dest',
				wheels,
				'--index-url',
				cpuWheel ? 'https://download.pytorch.org/whl/cpu' : 'https://pypi.org/simple',
				torch,
			],
			{ cwd: directory, signal: options.signal },
		)
		const constraints = join(paths.runtime, 'constraints.txt')
		await writeFile(
			constraints,
			`${[torch, numpy, 'huggingface-hub==2.1.1', 'normalizer-tr==0.4.0', ...runtimeDlls].join('\n')}\n`,
			{ mode: 0o600 },
		)
		await run(
			paths.python,
			[
				...pip,
				'download',
				'--only-binary=:all:',
				'--dest',
				wheels,
				'--find-links',
				wheels,
				'--constraint',
				constraints,
				'--index-url',
				'https://pypi.org/simple',
				`${EMA_WHEEL_URL}#sha256=${EMA_WHEEL_SHA256}`,
				numpy,
				'huggingface-hub==2.1.1',
				'normalizer-tr==0.4.0',
				...runtimeDlls,
			],
			{ cwd: directory, signal: options.signal },
		)
		await verifyRegularFile(
			join(wheels, 'ema_lightning-1.0.1-py3-none-any.whl'),
			undefined,
			EMA_WHEEL_SHA256,
		)
		const runtimeDownloadBytes = await treeBytes(wheels)
		await run(
			paths.python,
			[
				...pip,
				'install',
				'--no-index',
				'--find-links',
				wheels,
				'--only-binary=:all:',
				'--constraint',
				constraints,
				'ema-lightning==1.0.1',
				torch,
				numpy,
				'huggingface-hub==2.1.1',
				'normalizer-tr==0.4.0',
				...runtimeDlls,
			],
			{ cwd: directory, signal: options.signal },
		)
		if (runtimeDlls.length > 0) await copyVisualCRuntimeIntoTorch(join(paths.runtime, 'venv'))
		for (const model of EMA_MODEL_FILES)
			await downloadModel(model, join(paths.models, model.name), options)
		await run(
			paths.python,
			[
				'-I',
				'-c',
				'import importlib.metadata as m; assert m.version("ema-lightning") == "1.0.1"; import numpy,torch; assert torch.__version__.startswith("2.14.1")',
			],
			{ cwd: directory, signal: options.signal },
		)
		const installation: LocalSpeechInstallation = {
			v: 1,
			modelRevision: EMA_MODEL_REVISION,
			sourceRevision: EMA_SOURCE_REVISION,
			engineVersion: '1.0.1',
			runtimeDirectory,
			workerSha256: LOCAL_SPEECH_WORKER_SHA256,
			runtimeDownloadBytes,
			diskBytes: await treeBytes(paths.runtime),
			installedAt: new Date().toISOString(),
		}
		const temporary = join(directory, `installation-${randomUUID()}.tmp`)
		await writeFile(temporary, JSON.stringify(installation), { flag: 'wx', mode: 0o600 })
		await rename(temporary, join(directory, 'installation.json'))
		return installation
	} catch (error) {
		if (error instanceof LocalSpeechInstallShutdownError) throw error
		try {
			await rollbackRuntime(directory, runtimeDirectory, ownershipToken)
		} catch {
			throw new Error(
				'Local speech installation failed. Its incomplete runtime could not be safely removed.',
			)
		}
		throw error
	}
}

/** Used by native setup receipts; always confines a path to the selected private speech directory. */
export function localSpeechContainsPath(directory: string, path: string): boolean {
	const inside = relative(resolve(directory), resolve(path))
	return inside !== '' && !inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside)
}
