// Print the bundle entry of an archive, built from the archive alone (read with the independent
// reader). The publish job uses this instead of any file the build job wrote beside the archive.
//
//   node scripts/kernel/describe.mjs <archive.tar.gz> [--out <entry.json>] [--expect-version <x.y.z>]
//
// With --expect-version it fails unless the archive's kernel.json carries that command line version.
import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { isMain, parseFlags, runMain } from './cli.mjs'
import { bundleFileName } from './manifest.mjs'
import { describeArchive } from './verify.mjs'

async function main(args) {
	const { flags, positional } = parseFlags(args, { out: 'string', 'expect-version': 'string' })
	if (positional.length !== 1)
		throw new Error(
			'Usage: describe.mjs <archive.tar.gz> [--out <file>] [--expect-version <x.y.z>]',
		)
	const described = await describeArchive(positional[0])
	if (flags['expect-version'] && described.kernel.commandLine !== flags['expect-version'])
		throw new Error(
			`The archive carries the command line ${described.kernel.commandLine}, not the ${flags['expect-version']} this run is for.`,
		)
	const file = bundleFileName(described.kernel.commandLine, described.target)
	if (basename(positional[0]) !== file)
		throw new Error(
			`The archive is named ${basename(positional[0])}; its kernel.json says it should be ${file}.`,
		)
	const text = `${JSON.stringify({ target: described.target, kernel: described.kernel, bundle: { file, ...described.bundle } }, null, 2)}\n`
	if (flags.out) writeFileSync(flags.out, text)
	else process.stdout.write(text)
}

if (isMain(import.meta.url)) await runMain(main)
