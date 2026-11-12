// Pack a staged kernel folder (specification 4.2): files.json, then the archive
// namzu-kernel-<commandLine>-<platform>-<arch>.tar.gz, then the bundle entry for the manifest.
//
//   node scripts/kernel/pack.mjs <kernel-dir> --out <dir>
//
// Writes into <dir>: the archive, files.json, and <archive>.bundle.json (the bundle entry, also printed
// on standard output). Nothing is written into the kernel folder. The archive is read back with the
// independent reader before the command succeeds, so a writer that drifts from the text fails here.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { writeArchive } from './archive-writer.mjs'
import { isMain, parseFlags, runMain } from './cli.mjs'
import { bundleFileName } from './manifest.mjs'
import { describeArchive } from './verify.mjs'

/** Pack `kernelDir` into `outDir`. Returns `{ archive, entry, timings }`; `entry` is the bundle entry file's content. */
export async function packKernel({ kernelDir, outDir }) {
	let facts
	try {
		facts = JSON.parse(readFileSync(join(kernelDir, 'kernel.json'), 'utf8'))
	} catch {
		throw new Error(`${kernelDir} has no readable kernel.json; stage it with stage.mjs first.`)
	}
	const target = `${facts.platform}-${facts.arch}`
	mkdirSync(outDir, { recursive: true })
	const archive = join(outDir, bundleFileName(facts.commandLine, target))
	const started = process.hrtime.bigint()
	const written = await writeArchive({
		root: kernelDir,
		archivePath: archive,
		filesJsonPath: join(outDir, 'files.json'),
	})
	const packMs = Number(process.hrtime.bigint() - started) / 1e6
	// The reader's view of the archive is the one that counts.
	const described = await describeArchive(archive, {
		limits: { fileCount: written.bundle.fileCount, unpackedSize: written.bundle.unpackedSize },
	})
	for (const [key, value] of Object.entries(written.bundle))
		if (described.bundle[key] !== value)
			throw new Error(
				`The reader and the writer disagree about ${key} (${described.bundle[key]} and ${value}).`,
			)
	if (described.target !== target)
		throw new Error('kernel.json in the archive names another target.')
	const entry = {
		target,
		kernel: described.kernel,
		bundle: { file: bundleFileName(facts.commandLine, target), ...described.bundle },
	}
	writeFileSync(`${archive}.bundle.json`, `${JSON.stringify(entry, null, 2)}\n`)
	return { archive, entry, timings: { packMs } }
}

async function main(args) {
	const { flags, positional } = parseFlags(args, { out: 'string' })
	if (positional.length !== 1 || !flags.out)
		throw new Error('Usage: pack.mjs <kernel-dir> --out <dir>')
	const { archive, entry, timings } = await packKernel({
		kernelDir: resolve(positional[0]),
		outDir: resolve(flags.out),
	})
	process.stderr.write(`Packed ${archive} in ${timings.packMs.toFixed(0)} ms\n`)
	console.log(JSON.stringify(entry, null, 2))
}

if (isMain(import.meta.url)) await runMain(main)
