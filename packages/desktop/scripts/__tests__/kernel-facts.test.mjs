import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { childEnv } from '../check-staged-cli.mjs'
import {
	KernelFactsError,
	assembleKernelFacts,
	kernelJsonText,
	readKernelFacts,
} from '../kernel/facts.mjs'
import { stageCliFolder, withoutSigningKey } from '../kernel/stage-cli.mjs'
import { tempDir, writeTree } from './kernel-helpers.mjs'

/** A kernel folder whose dist/bin.js answers like the real one: --version, and initialize on `acp --desktop`. */
function fakeKernel({
	version = '1.2.3',
	printed = version,
	reply,
	exitBeforeAnswer = false,
	versionExit = 0,
}) {
	const dir = tempDir('fake-kernel')
	writeTree(dir, {
		'package.json': JSON.stringify({ name: '@namzu/cli', version }),
		'dist/bin.js': `
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log(${JSON.stringify(printed)}); process.exit(${versionExit}) }
if (args[0] === 'acp') {
	let buffer = ''
	process.stdin.on('data', (chunk) => {
		buffer += chunk
		if (!buffer.includes('\\n')) return
		const request = JSON.parse(buffer.split('\\n')[0])
		if (${exitBeforeAnswer}) process.exit(3)
		const kernel = ${JSON.stringify(reply ?? null)}
		const withContract = args.includes('--desktop')
		const result = { protocolVersion: 1, agentInfo: { name: 'namzu' }, extensions: [] }
		if (kernel) result.kernel = withContract ? kernel : { ...kernel, desktopContract: undefined }
		process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
	})
}
`,
	})
	return dir
}

const GOOD = { engine: '4.5.6', dataEpoch: 1, commandLine: '1.2.3', desktopContract: 1 }
const target = { platform: 'win32', arch: 'x64' }

test('kernel.json is written from what the kernel answers, in the order of the text, for the target', async () => {
	const facts = await readKernelFacts({ cliDir: fakeKernel({ reply: GOOD }), target })
	assert.deepEqual(facts, {
		schema: 1,
		commandLine: '1.2.3',
		engine: '4.5.6',
		desktopContract: 1,
		dataEpoch: 1,
		platform: 'win32',
		arch: 'x64',
	})
	assert.deepEqual(Object.keys(facts), [
		'schema',
		'commandLine',
		'engine',
		'desktopContract',
		'dataEpoch',
		'platform',
		'arch',
	])
	assert.equal(kernelJsonText(facts), `${JSON.stringify(facts)}\n`)
	assert.equal(
		(
			await readKernelFacts({
				cliDir: fakeKernel({ reply: GOOD }),
				target: { platform: 'linux', arch: 'arm64' },
			})
		).arch,
		'arm64',
	)
})

for (const [label, options, pattern] of [
	['a kernel with no kernel object in initialize', { reply: undefined }, /no `kernel` object/],
	[
		'a kernel with no desktop contract',
		{ reply: { ...GOOD, desktopContract: undefined } },
		/desktop contract/,
	],
	['a kernel with no engine', { reply: { ...GOOD, engine: undefined } }, /engine/],
	['a kernel with a data epoch of 0', { reply: { ...GOOD, dataEpoch: 0 } }, /data epoch/],
	[
		'a kernel whose command line differs from package.json',
		{ reply: { ...GOOD, commandLine: '9.9.9' } },
		/command line is "9\.9\.9"/,
	],
	[
		'a kernel whose --version differs from package.json',
		{ reply: GOOD, printed: '7.7.7' },
		/`--version` printed "7\.7\.7"/,
	],
	[
		'a kernel that exits before it answers',
		{ reply: GOOD, exitBeforeAnswer: true },
		/does not answer initialize/,
	],
	['a kernel whose --version fails', { reply: GOOD, versionExit: 2 }, /does not start/],
]) {
	test(`kernel.json error with a plain message: ${label}`, async () => {
		await assert.rejects(readKernelFacts({ cliDir: fakeKernel(options), target }), (error) => {
			assert.ok(error instanceof KernelFactsError)
			assert.match(
				error.message,
				/^The staged kernel (does not state its facts|does not start|does not answer)/,
			)
			assert.match(error.message, pattern)
			return true
		})
	})
}

test('assembleKernelFacts lists every problem at once', () => {
	assert.throws(
		() =>
			assembleKernelFacts({
				packageVersion: '1.2',
				versionOutput: '1.2',
				kernel: { commandLine: '1.2', engine: 'x', dataEpoch: 'a', desktopContract: 0 },
				target,
			}),
		(error) =>
			/not x\.y\.z/.test(error.message) &&
			/data epoch/.test(error.message) &&
			/desktop contract/.test(error.message),
	)
})

test('the installer staging and the kernel staging share one staging function and neither copies its steps', () => {
	const here = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
	for (const file of ['stage-installer.mjs', 'kernel/stage.mjs']) {
		const text = here(file)
		assert.match(text, /stageCliFolder/, file)
		assert.doesNotMatch(
			text,
			/'deploy'|leanCli\(|pruneDeadWeight\(join\(cli/,
			`${file} must not repeat the shared steps`,
		)
		assert.match(text, /readKernelFacts/, file)
	}
	assert.match(here('kernel/stage-cli.mjs'), /'deploy'/)
	const installer = here('stage-installer.mjs')
	assert.match(installer, /writeFileSync\(join\(cli, 'kernel\.json'\)/)
})

test('the signing key never reaches pnpm deploy or the staged program, even with it set in the environment', async () => {
	const key = 'KEY-VALUE-THAT-MUST-NOT-LEAK'
	assert.equal(
		withoutSigningKey({ A: '1', NAMZU_KERNEL_SIGNING_KEY: key }).NAMZU_KERNEL_SIGNING_KEY,
		undefined,
	)
	assert.equal(withoutSigningKey({ A: '1', NAMZU_KERNEL_SIGNING_KEY: key }).A, '1')
	process.env.NAMZU_KERNEL_SIGNING_KEY = key
	try {
		assert.equal(childEnv('/tmp/home').NAMZU_KERNEL_SIGNING_KEY, undefined)
	} finally {
		delete process.env.NAMZU_KERNEL_SIGNING_KEY
	}
	// The default runner: a stand-in `pnpm` on the path records its environment and fails.
	if (process.platform === 'win32') return
	const bin = tempDir('fake-pnpm')
	const seen = join(bin, 'seen.txt')
	writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\nenv > "${seen}"\nexit 1\n`)
	chmodSync(join(bin, 'pnpm'), 0o755)
	const before = { path: process.env.PATH, key: process.env.NAMZU_KERNEL_SIGNING_KEY }
	process.env.PATH = `${bin}:${process.env.PATH}`
	process.env.NAMZU_KERNEL_SIGNING_KEY = key
	try {
		await assert.rejects(
			stageCliFolder({
				repoRoot: bin,
				cli: join(bin, 'cli'),
				target: { platform: 'linux', arch: 'x64' },
				log: () => {},
			}),
		)
	} finally {
		process.env.PATH = before.path
		delete process.env.NAMZU_KERNEL_SIGNING_KEY
	}
	assert.ok(existsSync(seen), 'the stand-in pnpm ran')
	assert.equal(
		readFileSync(seen, 'utf8').includes(key),
		false,
		'pnpm deploy was handed the signing key',
	)
})

test('the kernel staging drops the file that records the staging path and time; the installer staging keeps it', () => {
	const here = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
	assert.match(here('kernel/stage.mjs'), /\.modules\.yaml/)
	assert.doesNotMatch(here('stage-installer.mjs'), /\.modules\.yaml/)
})
