// Stage a kernel folder (specification 4.1): the steps the installer staging uses for resources/cli
// (scripts/kernel/stage-cli.mjs), then kernel.json written from what the staged kernel answers.
//
//   node scripts/kernel/stage.mjs <out-dir> [--target win32-x64]
//
// <out-dir> becomes the kernel folder (dist/bin.js, package.json, node_modules, kernel.json). It is
// emptied first and must be outside the repository. Run `pnpm -r build` first.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTarget } from '../lean-cli.mjs'
import { isMain, parseFlags, runMain } from './cli.mjs'
import { kernelJsonText, readKernelFacts } from './facts.mjs'
import { stageCliFolder } from './stage-cli.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

/** Stage into `out` for `target`; returns the facts written to kernel.json. */
export async function stageKernel({ out, target, log = console.log }) {
	if (out === repoRoot || out.startsWith(`${repoRoot}/`) || out.startsWith(`${repoRoot}\\`))
		throw new Error('Stage outside the repository; build output does not belong in Git.')
	rmSync(out, { recursive: true, force: true })
	mkdirSync(out, { recursive: true })
	const staged = await stageCliFolder({ repoRoot, cli: out, target, log })
	// pnpm records the absolute path of the folder it staged into, and the time, in this file. Nothing
	// reads it at run time, and it would make two stagings of one commit differ. Only the kernel
	// staging drops it; the installer's folder is left as it was.
	rmSync(join(out, 'node_modules', '.modules.yaml'), { force: true })
	const facts = await readKernelFacts({ cliDir: out, target })
	writeFileSync(join(out, 'kernel.json'), kernelJsonText(facts))
	log(`kernel.json: ${JSON.stringify(facts)}`)
	return { facts, ...staged }
}

async function main(args) {
	const { flags, positional } = parseFlags(args, { target: 'string' })
	if (positional.length !== 1)
		throw new Error('Usage: stage.mjs <out-dir> [--target <platform>-<arch>]')
	await stageKernel({
		out: resolve(positional[0]),
		target: parseTarget(flags.target ?? 'win32-x64'),
	})
}

if (isMain(import.meta.url)) await runMain(main)
