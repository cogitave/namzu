#!/usr/bin/env node
// Checks a Pal computer image folder (manifest.json beside its archive) before it is shipped.
//
//   node check-pal-image.mjs files   <dir>   the folder holds exactly the manifest and the archive,
//                                            and the archive matches the manifest's size and SHA-256
//   node check-pal-image.mjs archive <dir>   the above, plus the archive's own contents: a single
//                                            image whose config digest equals manifest.imageId and
//                                            whose config carries manifest.protocol
//
// The app loads the archive with the container engine and refuses it unless the loaded image's id
// equals manifest.imageId, and that id is the digest of the image config. An engine that reports a
// manifest or index digest instead (Docker with the containerd image store does) writes a manifest
// the app would reject on every machine, so `archive` fails the build here rather than on a PC.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

export const IMAGE_REF = 'namzu-local-computer:2'
export const PROTOCOL_LABEL = 'org.namzu.local-computer.protocol'
// Entries up to this size are kept in memory (index, manifests, configs); layers are skipped.
const KEEP_LIMIT = 4 * 1024 * 1024

export class ImageCheckError extends Error {}

const fail = (message) => {
	throw new ImageCheckError(message)
}

async function sha256File(path) {
	const hash = createHash('sha256')
	for await (const chunk of createReadStream(path)) hash.update(chunk)
	return hash.digest('hex')
}

/** Folder holds exactly manifest.json and the archive it names, and the archive matches. */
export async function checkFiles(dir, imageRef = IMAGE_REF) {
	let manifest
	try {
		manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
	} catch {
		fail(`There is no readable pal-computer/manifest.json in ${dir}.`)
	}
	if (manifest.imageRef !== imageRef)
		fail(`The image is ${manifest.imageRef}, the app expects ${imageRef}.`)
	if (typeof manifest.file !== 'string' || /[\\/]/.test(manifest.file))
		fail('The manifest does not name its archive as a plain file name.')
	let size
	try {
		size = (await stat(join(dir, manifest.file))).size
	} catch {
		fail(`There is no ${manifest.file} in ${dir}.`)
	}
	if (size !== manifest.compressedBytes)
		fail(`${manifest.file} is ${size} bytes, the manifest says ${manifest.compressedBytes}.`)
	const sum = await sha256File(join(dir, manifest.file))
	if (sum !== manifest.sha256)
		fail(`${manifest.file} sha256 is ${sum}, the manifest says ${manifest.sha256}.`)
	const files = (await readdir(dir)).sort().join(',')
	if (files !== ['manifest.json', manifest.file].sort().join(','))
		fail(`Unexpected files in ${dir}: ${files}`)
	return { manifest, archive: join(dir, manifest.file), size, sha256: sum }
}

/** Yield the decompressed bytes of an archive; the codec is sniffed from the magic number. */
async function* decompressed(path) {
	const head = Buffer.alloc(4)
	const { open } = await import('node:fs/promises')
	const handle = await open(path, 'r')
	try {
		await handle.read(head, 0, 4, 0)
	} finally {
		await handle.close()
	}
	let codec
	if (head.readUInt32LE(0) === 0xfd2fb528) {
		if (typeof zlib.createZstdDecompress !== 'function')
			fail('Reading a zstd archive needs Node 22.15 or newer.')
		codec = zlib.createZstdDecompress()
	} else if (head[0] === 0x1f && head[1] === 0x8b) codec = zlib.createGunzip()
	else codec = null
	const source = createReadStream(path)
	yield* codec ? source.pipe(codec) : source
}

/** Read a tar stream, keeping every regular entry up to KEEP_LIMIT bytes. */
export async function readTarEntries(chunks) {
	const kept = new Map()
	let buffer = Buffer.alloc(0)
	let current // { name, size, remaining, keep, parts }
	let pad = 0
	let longName
	for await (const chunk of chunks) {
		buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
		for (;;) {
			if (current) {
				if (buffer.length === 0) break
				const take = Math.min(current.remaining, buffer.length)
				if (current.parts) current.parts.push(buffer.subarray(0, take))
				current.remaining -= take
				buffer = buffer.subarray(take)
				if (current.remaining > 0) break
				const data = current.parts ? Buffer.concat(current.parts) : undefined
				if (current.longName) longName = data.toString('utf8').replace(/\0+$/, '')
				else if (data && current.type !== 'x' && current.type !== 'g') kept.set(current.name, data)
				pad = (512 - (current.size % 512)) % 512
				current = undefined
			}
			if (pad > 0) {
				if (buffer.length < pad) break
				buffer = buffer.subarray(pad)
				pad = 0
			}
			if (buffer.length < 512) break
			const header = buffer.subarray(0, 512)
			buffer = buffer.subarray(512)
			if (header.every((byte) => byte === 0)) continue
			const text = (from, to) => header.toString('utf8', from, to).replace(/\0.*$/s, '')
			const size = Number.parseInt(text(124, 136).trim() || '0', 8)
			if (!Number.isFinite(size)) fail('The archive is not a readable tar file.')
			const type = text(156, 157) || '0'
			const prefix = text(345, 500)
			let name = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100)
			if (longName) {
				name = longName
				longName = undefined
			}
			const regular = type === '0' || type === '\0'
			const meta = type === 'L' || type === 'x' || type === 'g'
			current = {
				name: name.replace(/^\.\//, ''),
				size,
				remaining: size,
				type,
				longName: type === 'L',
				parts: (regular && size <= KEEP_LIMIT) || meta ? [] : undefined,
			}
			if (size === 0) {
				if (current.parts) kept.set(current.name, Buffer.alloc(0))
				current = undefined
			}
		}
	}
	return kept
}

const digestOf = (blob) => `sha256:${createHash('sha256').update(blob).digest('hex')}`

/** The archive holds one image, its config digest is manifest.imageId, its label is manifest.protocol. */
export function checkImageContents(entries, manifest) {
	const json = (name) => {
		const data = entries.get(name)
		if (!data) fail(`The image archive has no ${name}.`)
		try {
			return JSON.parse(data.toString('utf8'))
		} catch {
			fail(`${name} in the image archive is not JSON.`)
		}
	}
	if (!entries.has('oci-layout')) fail('The image archive has no oci-layout file.')
	const index = json('index.json')
	if (!Array.isArray(index.manifests) || index.manifests.length !== 1)
		fail(
			`index.json lists ${Array.isArray(index.manifests) ? index.manifests.length : 'no'} manifests, expected exactly one (an extra entry is usually an attestation).`,
		)
	const docker = json('manifest.json')
	if (!Array.isArray(docker) || docker.length !== 1)
		fail('manifest.json must describe exactly one image.')
	const [image] = docker
	if (!Array.isArray(image.RepoTags) || !image.RepoTags.includes(manifest.imageRef))
		fail(`manifest.json does not tag the image ${manifest.imageRef}: ${JSON.stringify(image.RepoTags)}.`)
	if (typeof image.Config !== 'string') fail('manifest.json names no config blob.')
	const configDigest = `sha256:${image.Config.replace(/^blobs\/sha256\//, '').replace(/\.json$/, '')}`
	if (!/^sha256:[0-9a-f]{64}$/.test(configDigest)) fail(`Unreadable config blob name: ${image.Config}.`)
	if (configDigest !== manifest.imageId)
		fail(
			`The image's config digest is ${configDigest} but the manifest says ${manifest.imageId}. The app loads the image and compares ids, so this installer would be refused on every PC. Build with an engine that reports the config digest as the image id (for Docker, the classic image store).`,
		)
	const config = entries.get(image.Config)
	if (!config) fail(`The image archive has no config blob ${image.Config}.`)
	if (digestOf(config) !== configDigest) fail('The config blob does not hash to its own name.')
	const labels = JSON.parse(config.toString('utf8'))?.config?.Labels ?? {}
	if (labels[PROTOCOL_LABEL] !== manifest.protocol)
		fail(`The image's ${PROTOCOL_LABEL} label is ${labels[PROTOCOL_LABEL]}, the manifest says ${manifest.protocol}.`)
	return { configDigest, layers: Array.isArray(image.Layers) ? image.Layers.length : 0 }
}

export async function checkArchive(dir, imageRef = IMAGE_REF) {
	const files = await checkFiles(dir, imageRef)
	const entries = await readTarEntries(decompressed(files.archive))
	return { ...files, ...checkImageContents(entries, files.manifest) }
}

async function main(argv) {
	const [mode, dir] = argv
	if ((mode !== 'files' && mode !== 'archive') || !dir) {
		process.stderr.write('Usage: check-pal-image.mjs <files|archive> <dir>\n')
		return 2
	}
	try {
		const result = await (mode === 'files' ? checkFiles : checkArchive)(resolve(dir))
		const extra = result.configDigest ? ` image ${result.configDigest} (${result.layers} layers)` : ''
		process.stdout.write(`Pal computer image ok: ${result.manifest.file} ${result.size} bytes sha256 ${result.sha256}${extra}\n`)
		return 0
	} catch (error) {
		if (!(error instanceof ImageCheckError)) throw error
		process.stderr.write(`${error.message}\n`)
		return 1
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main(process.argv.slice(2))
}
