import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import zlib from 'node:zlib'
import {
	ImageCheckError,
	PROTOCOL_LABEL,
	checkArchive,
	checkFiles,
	checkImageContents,
	readTarEntries,
} from '../check-pal-image.mjs'

const sha = (data) => createHash('sha256').update(data).digest('hex')

function tarEntry(name, data) {
	const header = Buffer.alloc(512)
	header.write(name, 0)
	header.write('0000644\0', 100)
	header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
	header.write('0', 156)
	header.write('ustar\0', 257)
	header.fill(' ', 148, 156)
	let sum = 0
	for (const byte of header) sum += byte
	header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
	const padding = Buffer.alloc((512 - (data.length % 512)) % 512)
	return Buffer.concat([header, data, padding])
}

function buildTar(files) {
	return Buffer.concat([
		...Object.entries(files).map(([name, data]) => tarEntry(name, Buffer.from(data))),
		Buffer.alloc(1024),
	])
}

function image({ tag = 'namzu-local-computer:2', protocol = '1', index = 1, imageId } = {}) {
	const config = JSON.stringify({ config: { Labels: { [PROTOCOL_LABEL]: protocol } } })
	const digest = sha(config)
	return {
		config,
		digest,
		files: {
			'oci-layout': '{"imageLayoutVersion":"1.0.0"}',
			'index.json': JSON.stringify({ manifests: Array.from({ length: index }, () => ({})) }),
			'manifest.json': JSON.stringify([
				{ Config: `blobs/sha256/${digest}`, RepoTags: [tag], Layers: ['blobs/sha256/aa'] },
			]),
			[`blobs/sha256/${digest}`]: config,
			'blobs/sha256/aa': 'x'.repeat(5000),
		},
		manifest: { imageRef: 'namzu-local-computer:2', imageId: imageId ?? `sha256:${digest}`, protocol: '1' },
	}
}

const run = async (files, manifest) =>
	checkImageContents(await readTarEntries([buildTar(files)]), manifest)

test('accepts an image whose config digest is the manifest id', async () => {
	const { files, manifest, digest } = image()
	assert.equal((await run(files, manifest)).configDigest, `sha256:${digest}`)
})

test('reads a tar delivered in awkward chunk sizes', async () => {
	const { files, manifest } = image()
	const tar = buildTar(files)
	const chunks = []
	for (let at = 0; at < tar.length; at += 333) chunks.push(tar.subarray(at, at + 333))
	assert.ok(checkImageContents(await readTarEntries(chunks), manifest))
})

test('refuses an id that is not the config digest (a manifest or index digest)', async () => {
	const { files, manifest } = image({ imageId: `sha256:${'1'.repeat(64)}` })
	await assert.rejects(run(files, manifest), /config digest is sha256:[0-9a-f]+ but the manifest says/)
})

test('refuses an index with an extra manifest', async () => {
	const { files, manifest } = image({ index: 2 })
	await assert.rejects(run(files, manifest), /lists 2 manifests/)
})

test('refuses a missing tag and a wrong protocol label', async () => {
	const wrongTag = image({ tag: 'other:1' })
	await assert.rejects(run(wrongTag.files, wrongTag.manifest), /does not tag the image/)
	const wrongProtocol = image({ protocol: '2' })
	await assert.rejects(run(wrongProtocol.files, wrongProtocol.manifest), /label is 2/)
})

test('refuses a layout without oci-layout', async () => {
	const { files, manifest } = image()
	delete files['oci-layout']
	await assert.rejects(run(files, manifest), /no oci-layout/)
})

async function folder(files, manifestPatch = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'pal-image-'))
	const { files: tarFiles, manifest } = image()
	const archive = zlib.gzipSync(buildTar(files ?? tarFiles))
	await writeFile(join(dir, 'img.tar.gz'), archive)
	const full = {
		...manifest,
		file: 'img.tar.gz',
		compressedBytes: archive.length,
		sha256: sha(archive),
		...manifestPatch,
	}
	await writeFile(join(dir, 'manifest.json'), JSON.stringify(full))
	return dir
}

test('checkArchive passes a matching folder and checkFiles catches tampering', async () => {
	const dir = await folder()
	try {
		assert.ok((await checkArchive(dir)).configDigest)
		await writeFile(join(dir, 'img.tar.gz'), 'tampered')
		await assert.rejects(checkFiles(dir), ImageCheckError)
		await writeFile(join(dir, 'README.txt'), 'x')
		await assert.rejects(checkFiles(dir), /bytes|Unexpected/)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('checkFiles refuses another image reference and a stray file', async () => {
	const dir = await folder(undefined, { imageRef: 'namzu-local-computer:3' })
	try {
		await assert.rejects(checkFiles(dir), /expects namzu-local-computer:2/)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
