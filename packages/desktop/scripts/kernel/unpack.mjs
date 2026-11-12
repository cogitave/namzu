import { once } from 'node:events'
// Unpack an archive into a new folder with the reader's rules (for inspection and the integration
// check; the app has its own extraction). The folder is removed again if the archive is refused.
//
//   node scripts/kernel/unpack.mjs <archive.tar.gz> <out-dir> [--manifest <kernel-latest.json>]
//
// With --manifest the archive's limits (file count, unpacked size) come from the bundle it names.
import { createWriteStream, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { readArchive } from './archive-reader.mjs'
import { isMain, parseFlags, runMain } from './cli.mjs'
import { parseManifest } from './manifest.mjs'

export async function unpackArchive({ archive, out, limits }) {
	const root = resolve(out)
	mkdirSync(root, { recursive: false })
	let stream
	try {
		await readArchive(archive, {
			limits,
			sink: {
				begin(path) {
					const target = join(root, ...path.split('/'))
					mkdirSync(dirname(target), { recursive: true })
					stream = createWriteStream(target, { flags: 'wx' })
				},
				async write(chunk) {
					if (!stream.write(chunk)) await once(stream, 'drain')
				},
				async end() {
					stream.end()
					await once(stream, 'finish')
				},
			},
		})
	} catch (error) {
		stream?.destroy()
		rmSync(root, { recursive: true, force: true })
		throw error
	}
}

async function main(args) {
	const { flags, positional } = parseFlags(args, { manifest: 'string' })
	if (positional.length !== 2)
		throw new Error('Usage: unpack.mjs <archive.tar.gz> <out-dir> [--manifest <file>]')
	let limits
	if (flags.manifest) {
		const manifest = parseManifest(readFileSync(flags.manifest))
		const bundle = Object.values(manifest.kernel.bundles).find(
			(b) => b.file === basename(positional[0]),
		)
		if (!bundle) throw new Error(`The manifest has no bundle named ${basename(positional[0])}.`)
		limits = { fileCount: bundle.fileCount, unpackedSize: bundle.unpackedSize }
	}
	await unpackArchive({ archive: positional[0], out: positional[1], limits })
	console.log(`Unpacked ${positional[0]} into ${positional[1]}`)
}

if (isMain(import.meta.url)) await runMain(main)
