#!/usr/bin/env node
// Build one stage of the Pal computer image with a container engine, save it,
// compress it and write a manifest the installer carries beside it.
//
//   node build-image.mjs --engine docker --stage base --out ./out
//   node build-image.mjs --engine wslc --stage base --tag namzu-local-computer:2 --out ./out --format zst
//
// The engine is any binary with `build`, `image inspect` and `save` (docker, podman,
// wslc). Every external command goes through an injected runner, so the tests drive
// this module without an engine.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

export const STAGES = ['base', 'creative']
export const PROTOCOL_LABEL = 'org.namzu.local-computer.protocol'
/** `wslc load -i` sniffs the content, so any of these loads without a separate decompression step. */
export const FORMATS = ['zst', 'xz', 'gz', 'tar']
const DEFAULT_TAGS = { base: 'namzu-local-computer:2', creative: 'namzu-local-computer:2-creative' }
const EXTENSIONS = { zst: 'tar.zst', xz: 'tar.xz', gz: 'tar.gz', tar: 'tar' }
const DEFAULT_LEVELS = { zst: 19, xz: 9, gz: 9, tar: 0 }

export class BuildImageError extends Error {
	constructor(message) {
		super(message)
		this.name = 'BuildImageError'
	}
}

const HERE = dirname(fileURLToPath(import.meta.url))

export function defaultTag(stage) {
	return DEFAULT_TAGS[stage]
}

/** The integer revision a tag names: `ns/name:2` and `ns/name:2-creative` are both revision 2. */
export function revisionFromTag(tag) {
	const match = /:(\d+)(?:-[A-Za-z0-9._]+)?$/.exec(tag)
	return match ? Number(match[1]) : undefined
}

export function usage() {
	return [
		'Usage: build-image.mjs --engine <docker|podman|wslc|path> --out <dir> [options]',
		'',
		'  --engine <bin>      container engine binary that builds, inspects and saves',
		'  --stage <name>      base (default) or creative',
		'  --tag <ref>         image reference (default namzu-local-computer:2, or :2-creative)',
		'  --out <dir>         directory for the archive and manifest.json',
		'  --format <fmt>      zst (default), xz, gz or tar; all load directly with wslc load -i',
		'  --level <n>         compression level (zst 19, xz 9, gz 9)',
		'  --revision <n>      manifest revision (default: the number in the tag)',
		'  --context <dir>     build context (default packages/sandbox)',
		'  --dockerfile <file> Dockerfile (default local-computer/Dockerfile)',
		'  --no-cache          build without the engine cache',
		'  --skip-build        save the existing image instead of building it',
	].join('\n')
}

export function parseArguments(argv) {
	const options = {
		engine: undefined,
		stage: 'base',
		tag: undefined,
		out: undefined,
		format: 'zst',
		level: undefined,
		revision: undefined,
		context: resolve(HERE, '..'),
		dockerfile: join(HERE, 'Dockerfile'),
		noCache: false,
		skipBuild: false,
	}
	const value = (index, flag) => {
		const next = argv[index + 1]
		if (next === undefined || next.startsWith('--'))
			throw new BuildImageError(`${flag} needs a value`)
		return next
	}
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index]
		switch (flag) {
			case '--engine':
				options.engine = value(index++, flag)
				break
			case '--stage':
				options.stage = value(index++, flag)
				break
			case '--tag':
				options.tag = value(index++, flag)
				break
			case '--out':
				options.out = resolve(value(index++, flag))
				break
			case '--format':
				options.format = value(index++, flag)
				break
			case '--level':
				options.level = Number(value(index++, flag))
				break
			case '--revision':
				options.revision = Number(value(index++, flag))
				break
			case '--context':
				options.context = resolve(value(index++, flag))
				break
			case '--dockerfile':
				options.dockerfile = resolve(value(index++, flag))
				break
			case '--no-cache':
				options.noCache = true
				break
			case '--skip-build':
				options.skipBuild = true
				break
			default:
				throw new BuildImageError(`Unknown argument: ${flag}`)
		}
	}
	if (!options.engine) throw new BuildImageError('--engine is required')
	if (!options.out) throw new BuildImageError('--out is required')
	if (!STAGES.includes(options.stage))
		throw new BuildImageError(`--stage must be one of ${STAGES.join(', ')}`)
	if (!FORMATS.includes(options.format))
		throw new BuildImageError(`--format must be one of ${FORMATS.join(', ')}`)
	options.tag ??= defaultTag(options.stage)
	if (!/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+$/.test(options.tag))
		throw new BuildImageError(`--tag is not an image reference: ${options.tag}`)
	options.revision ??= revisionFromTag(options.tag)
	if (!Number.isInteger(options.revision) || options.revision < 1)
		throw new BuildImageError('--revision must be a positive integer (or a tag ending in :<n>)')
	options.level ??= DEFAULT_LEVELS[options.format]
	if (!Number.isInteger(options.level) || options.level < 0 || options.level > 22)
		throw new BuildImageError('--level must be an integer from 0 to 22')
	return options
}

/** Real command runner: argv array, no shell, output captured (inherited for long builds). */
export function spawnRunner(file, args, { cwd, inherit = false } = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(file, args, { cwd, stdio: inherit ? ['ignore', 'inherit', 'inherit'] : 'pipe' })
		let stdout = ''
		let stderr = ''
		child.stdout?.on('data', (chunk) => {
			stdout += chunk
		})
		child.stderr?.on('data', (chunk) => {
			stderr += chunk
		})
		child.once('error', reject)
		child.once('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }))
	})
}

async function exec(run, file, args, options) {
	const result = await run(file, args, options)
	if (result.code !== 0)
		throw new BuildImageError(
			`${basename(file)} ${args[0]} failed (${result.code}): ${(result.stderr || result.stdout || '').trim().slice(-500)}`,
		)
	return result
}

async function sha256File(path) {
	const hash = createHash('sha256')
	await pipeline(createReadStream(path), hash)
	return hash.digest('hex')
}

/** Compress `source` to `destination`. xz has no Node codec, so it runs the engine host's `xz`. */
export async function compressFile({ run, source, destination, format, level }) {
	if (format === 'tar') {
		await rename(source, destination)
		return
	}
	if (format === 'xz') {
		await exec(run, 'xz', [`-${level}e`, '--keep', '--force', '--threads=0', source])
		await rename(`${source}.xz`, destination)
		await rm(source, { force: true })
		return
	}
	let codec
	if (format === 'gz') codec = zlib.createGzip({ level })
	else {
		if (typeof zlib.createZstdCompress !== 'function')
			throw new BuildImageError('zstd needs Node 22.15 or newer, or use --format gz or xz')
		codec = zlib.createZstdCompress({
			params: {
				[zlib.constants.ZSTD_c_compressionLevel]: level,
				// No worker threads: Node's zstd stream fails with "stream.push() after EOF" when they
				// are on (checked on Node 22.20 and 24.19). One thread takes about 5 minutes at level 19 (measured on the base stage).
				[zlib.constants.ZSTD_c_checksumFlag]: 1,
			},
		})
	}
	await pipeline(createReadStream(source), codec, createWriteStream(destination))
	await rm(source, { force: true })
}

/**
 * Build, save and compress one stage, then write manifest.json beside the archive.
 * `run(file, args, { cwd, inherit })` resolves { code, stdout, stderr }.
 */
export async function buildImage(options, { run = spawnRunner, log = () => {} } = {}) {
	const { engine, stage, tag, out, format, level, revision, context, dockerfile } = options
	await mkdir(out, { recursive: true })
	const started = Date.now()
	if (!options.skipBuild) {
		const args = ['build', '--file', dockerfile, '--target', stage, '--tag', tag]
		if (options.noCache) args.push('--no-cache')
		args.push(context)
		log(`building ${tag} (${stage})`)
		await exec(run, engine, args, { inherit: true })
	}
	const inspected = await exec(run, engine, ['image', 'inspect', tag])
	let record
	try {
		record = JSON.parse(inspected.stdout)
		if (Array.isArray(record)) record = record[0]
	} catch {
		throw new BuildImageError(`image inspect ${tag} did not print JSON`)
	}
	const imageId = record?.Id ?? record?.ID
	const protocol = record?.Config?.Labels?.[PROTOCOL_LABEL]
	if (typeof imageId !== 'string' || !imageId) throw new BuildImageError(`${tag} has no image id`)
	if (typeof protocol !== 'string' || !protocol)
		throw new BuildImageError(`${tag} has no ${PROTOCOL_LABEL} label`)
	const built = Date.now()

	const stem = `${tag.replace(/[/:]/g, '-')}`
	const tarPath = join(out, `${stem}.tar`)
	log(`saving ${tag}`)
	await exec(run, engine, ['save', '--output', tarPath, tag])
	const sizeBytes = (await stat(tarPath)).size
	const tarSha256 = await sha256File(tarPath)
	const archive = join(out, `${stem}.${EXTENSIONS[format]}`)
	log(`compressing to ${basename(archive)}`)
	await compressFile({ run, source: tarPath, destination: archive, format, level })
	const compressedBytes = (await stat(archive)).size
	const sha256 = await sha256File(archive)
	const manifest = {
		revision,
		imageRef: tag,
		imageId,
		protocol,
		sha256,
		sizeBytes,
		compressedBytes,
		format,
		file: basename(archive),
		stage,
		tarSha256,
	}
	const manifestPath = join(out, 'manifest.json')
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
	return {
		manifest,
		manifestPath,
		archive,
		buildMs: built - started,
		totalMs: Date.now() - started,
	}
}

/** Read a manifest back and check it against the archive beside it. */
export async function verifyManifest(manifestPath) {
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
	const archive = join(dirname(manifestPath), manifest.file)
	const info = await stat(archive)
	if (info.size !== manifest.compressedBytes)
		throw new BuildImageError(`${manifest.file} is ${info.size} bytes, manifest says ${manifest.compressedBytes}`)
	if ((await sha256File(archive)) !== manifest.sha256)
		throw new BuildImageError(`${manifest.file} does not match the manifest sha256`)
	return manifest
}

export async function main(argv, deps = {}) {
	if (argv.includes('--help') || argv.includes('-h')) {
		process.stdout.write(`${usage()}\n`)
		return 0
	}
	let options
	try {
		options = parseArguments(argv)
	} catch (error) {
		process.stderr.write(`${error.message}\n\n${usage()}\n`)
		return 2
	}
	try {
		const result = await buildImage(options, {
			...deps,
			log: (line) => process.stderr.write(`${line}\n`),
		})
		process.stdout.write(`${JSON.stringify({ ...result.manifest, buildMs: result.buildMs, totalMs: result.totalMs })}\n`)
		return 0
	} catch (error) {
		process.stderr.write(`${error.message}\n`)
		return 1
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main(process.argv.slice(2))
}
