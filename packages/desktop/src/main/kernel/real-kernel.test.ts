import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledCliEntry } from '../bundled-runtime.js'
import { askBundledEngine } from '../engine-delivery.js'
import { REQUIRED_EXTENSIONS } from '../required-extensions.js'
import { bundledFactsReader, parseKernelFacts } from './facts.js'
import { nodeFs } from './fs.js'
import { createProbe } from './self-check.js'

/**
 * The bundled engine's own facts against a REAL command line (packages/cli/dist, built by
 * `pnpm -r build`), laid out the way the installer staging leaves resources/cli: dist/, package.json
 * and kernel.json side by side. The facts file is written by the publisher's own staging function.
 * Starting a real program is slow work, so these tests carry a long limit; none of them decides
 * its outcome by a timer.
 */
const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'cli')
const REAL_PROGRAM_LIMIT_MS = 120_000

const dirs: string[] = []
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** `<resources>/cli` with the built command line's dist (linked, not copied) and its package.json. */
async function stagedLayout(): Promise<{ resources: string; cli: string }> {
	const resources = await mkdtemp(join(tmpdir(), 'namzu-resources-'))
	dirs.push(resources)
	const cli = join(resources, 'cli')
	await mkdir(cli, { recursive: true })
	await symlink(join(cliRoot, 'dist'), join(cli, 'dist'), 'dir')
	await cp(join(cliRoot, 'package.json'), join(cli, 'package.json'))
	return { resources, cli }
}

function realProbe() {
	return createProbe({
		program: process.execPath,
		env: process.env,
		requiredExtensions: REQUIRED_EXTENSIONS,
		after: (ms, run) => {
			const timer = setTimeout(run, ms)
			return () => clearTimeout(timer)
		},
		clientVersion: '0.0.0',
	})
}

describe('the bundled engine facts, against the real command line', () => {
	it(
		'reads kernel.json from the staged layout, and it agrees with what the real command line says',
		async () => {
			const { readKernelFacts, kernelJsonText } = (await import(
				/* @vite-ignore */ new URL('../../../scripts/kernel/facts.mjs', import.meta.url).href
			)) as {
				readKernelFacts: (options: {
					cliDir: string
					target: { platform: string; arch: string }
				}) => Promise<unknown>
				kernelJsonText: (facts: unknown) => string
			}
			const { resources, cli } = await stagedLayout()
			const target = { platform: process.platform, arch: process.arch }
			await writeFile(
				join(cli, 'kernel.json'),
				kernelJsonText(await readKernelFacts({ cliDir: cli, target })),
			)

			// The app finds the entry where the installer puts it, and the facts beside it.
			const entry = bundledCliEntry({ isPackaged: true, resourcesPath: resources })
			expect(entry).toBe(join(cli, 'dist', 'bin.js'))
			const onDisk = parseKernelFacts(await readFile(join(cli, 'kernel.json')))
			const read = await bundledFactsReader({
				fs: nodeFs,
				cliFolder: dirname(dirname(entry as string)),
			})()
			const packageVersion = JSON.parse(
				await readFile(join(cliRoot, 'package.json'), 'utf8'),
			).version
			expect(read).toEqual({
				commandLine: packageVersion,
				engine: onDisk.engine,
				dataEpoch: onDisk.dataEpoch,
				desktopContract: onDisk.desktopContract,
			})
			expect(onDisk).toMatchObject({ schema: 1, platform: target.platform, arch: target.arch })

			// What the real program says about itself when asked is the same.
			const asked = await askBundledEngine(realProbe(), entry as string)
			expect(asked).toEqual({
				engine: read?.engine,
				dataEpoch: read?.dataEpoch,
				commandLine: read?.commandLine,
				desktopContract: read?.desktopContract,
			})
		},
		REAL_PROGRAM_LIMIT_MS,
	)

	it(
		'asks the real bundled engine once when kernel.json is missing, and gets the same facts',
		async () => {
			const { resources, cli } = await stagedLayout()
			const entry = bundledCliEntry({ isPackaged: true, resourcesPath: resources }) as string
			await expect(readFile(join(cli, 'kernel.json'))).rejects.toThrow()
			let asks = 0
			const reader = bundledFactsReader({
				fs: nodeFs,
				cliFolder: cli,
				ask: () => {
					asks++
					return askBundledEngine(realProbe(), entry)
				},
			})
			const first = await reader()
			const second = await reader()
			expect(asks).toBe(1)
			expect(second).toBe(first)
			const packageVersion = JSON.parse(
				await readFile(join(cliRoot, 'package.json'), 'utf8'),
			).version
			expect(first).toMatchObject({ commandLine: packageVersion, dataEpoch: 1, desktopContract: 1 })
			expect(first?.engine).toMatch(/^\d+\.\d+\.\d+/u)
		},
		REAL_PROGRAM_LIMIT_MS,
	)

	it(
		'falls back to asking when the staged kernel.json is damaged',
		async () => {
			const { resources, cli } = await stagedLayout()
			await writeFile(join(cli, 'kernel.json'), '{"schema":1')
			const entry = bundledCliEntry({ isPackaged: true, resourcesPath: resources }) as string
			const facts = await bundledFactsReader({
				fs: nodeFs,
				cliFolder: cli,
				ask: () => askBundledEngine(realProbe(), entry),
			})()
			expect(facts?.dataEpoch).toBe(1)
		},
		REAL_PROGRAM_LIMIT_MS,
	)
})
