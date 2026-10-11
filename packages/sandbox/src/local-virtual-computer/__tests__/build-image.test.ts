import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'

type Command = { file: string; args: string[] }
type Run = (
	file: string,
	args: string[],
	options?: { cwd?: string; inherit?: boolean },
) => Promise<{ code: number; stdout: string; stderr: string }>
type Options = Record<string, unknown> & {
	engine: string
	stage: string
	tag: string
	out: string
	format: string
	level: number
	revision: number
	context: string
	dockerfile: string
	noCache: boolean
	skipBuild: boolean
}
const tool = (await import(
	/* @vite-ignore */ pathToFileURL(
		join(import.meta.dirname, '../../../local-computer/build-image.mjs'),
	).href
)) as {
	parseArguments: (argv: string[]) => Options
	buildImage: (
		options: Options,
		deps: { run: Run },
	) => Promise<{ manifest: Record<string, unknown>; archive: string; manifestPath: string }>
	verifyManifest: (path: string) => Promise<Record<string, unknown>>
	revisionFromTag: (tag: string) => number | undefined
	defaultTag: (stage: string) => string
	main: (argv: string[], deps: { run: Run }) => Promise<number>
	PROTOCOL_LABEL: string
}

const IMAGE_ID = `sha256:${'ab'.repeat(32)}`
const PAYLOAD = Buffer.from('layer bytes '.repeat(5000))

/** A stand-in engine: records every command and writes a tar for `save`. */
function fakeEngine(overrides: { labels?: Record<string, string>; failOn?: string } = {}) {
	const commands: Command[] = []
	const run: Run = async (file, args) => {
		commands.push({ file, args })
		if (overrides.failOn === args[0])
			return { code: 1, stdout: '', stderr: `${args[0]} exploded\nError code: E_FAIL` }
		if (args[0] === 'image' && args[1] === 'inspect')
			return {
				code: 0,
				stderr: '',
				stdout: JSON.stringify([
					{
						Id: IMAGE_ID,
						Config: {
							Labels: overrides.labels ?? { [tool.PROTOCOL_LABEL]: '1' },
							User: '1001:1001',
						},
					},
				]),
			}
		if (args[0] === 'save') {
			await writeFile(args[args.indexOf('--output') + 1] as string, PAYLOAD)
			return { code: 0, stdout: '', stderr: '' }
		}
		return { code: 0, stdout: '', stderr: '' }
	}
	return { commands, run }
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

describe('build-image arguments', () => {
	const base = ['--engine', 'wslc', '--out', 'out']

	it('defaults to the base stage, the :2 tag, zstd and revision 2', () => {
		const options = tool.parseArguments(base)
		expect(options).toMatchObject({
			engine: 'wslc',
			stage: 'base',
			tag: 'namzu-local-computer:2',
			format: 'zst',
			level: 19,
			revision: 2,
			noCache: false,
			skipBuild: false,
		})
		expect(options.dockerfile.endsWith('Dockerfile')).toBe(true)
	})

	it('takes the creative tag and the revision from the stage and the tag', () => {
		expect(tool.parseArguments([...base, '--stage', 'creative']).tag).toBe(
			'namzu-local-computer:2-creative',
		)
		expect(tool.revisionFromTag('namzu-local-computer:2-creative')).toBe(2)
		expect(tool.revisionFromTag('ghcr.io/x/y:14')).toBe(14)
		expect(tool.revisionFromTag('namzu-local-computer:latest')).toBeUndefined()
		expect(tool.parseArguments([...base, '--tag', 'namzu-t2-base:7']).revision).toBe(7)
		expect(tool.defaultTag('base')).toBe('namzu-local-computer:2')
	})

	it('reads every option', () => {
		expect(
			tool.parseArguments([
				...base,
				'--stage',
				'creative',
				'--tag',
				'x/y:3',
				'--format',
				'xz',
				'--level',
				'6',
				'--revision',
				'9',
				'--context',
				'ctx',
				'--dockerfile',
				'df',
				'--no-cache',
				'--skip-build',
			]),
		).toMatchObject({
			stage: 'creative',
			tag: 'x/y:3',
			format: 'xz',
			level: 6,
			revision: 9,
			noCache: true,
			skipBuild: true,
		})
	})

	it.each([
		[['--out', 'o'], '--engine is required'],
		[['--engine', 'docker'], '--out is required'],
		[[...base, '--stage', 'tiny'], '--stage must be one of'],
		[[...base, '--format', 'zip'], '--format must be one of'],
		[[...base, '--tag', 'no-colon'], 'not an image reference'],
		[[...base, '--tag', 'x:latest'], '--revision must be a positive integer'],
		[[...base, '--level', '99'], '--level must be an integer'],
		[[...base, '--engine'], '--engine needs a value'],
		[[...base, '--bogus'], 'Unknown argument: --bogus'],
	])('rejects %j', (argv, message) => {
		expect(() => tool.parseArguments(argv as string[])).toThrow(message as string)
	})
})

describe('build-image build, save and manifest', () => {
	it('builds the chosen stage, saves it and writes a manifest that matches the archive', async () => {
		const out = await mkdtemp(join(tmpdir(), 'namzu-build-image-'))
		try {
			const engine = fakeEngine()
			const options = tool.parseArguments([
				'--engine',
				'C:\\Program Files\\WSL\\wslc.exe',
				'--out',
				out,
				'--stage',
				'base',
				'--tag',
				'namzu-t2-base:2',
				'--format',
				'gz',
				'--no-cache',
			])
			const result = await tool.buildImage(options, { run: engine.run })
			expect(
				engine.commands.map((c) => (c.args[0] === 'image' ? 'image inspect' : c.args[0])),
			).toEqual(['build', 'image inspect', 'save'])
			const build = engine.commands[0]?.args as string[]
			expect(build).toEqual(
				expect.arrayContaining(['--target', 'base', '--tag', 'namzu-t2-base:2', '--no-cache']),
			)
			expect(build.at(-1)).toBe(options.context)
			expect(engine.commands.every((c) => c.file === 'C:\\Program Files\\WSL\\wslc.exe')).toBe(true)
			const archive = await readFile(result.archive)
			expect(archive.subarray(0, 2).toString('hex')).toBe('1f8b')
			expect(zlib.gunzipSync(archive).equals(PAYLOAD)).toBe(true)
			expect(result.manifest).toEqual({
				revision: 2,
				imageRef: 'namzu-t2-base:2',
				imageId: IMAGE_ID,
				protocol: '1',
				sha256: sha256(archive),
				sizeBytes: PAYLOAD.length,
				compressedBytes: archive.length,
				format: 'gz',
				file: 'namzu-t2-base-2.tar.gz',
				stage: 'base',
				tarSha256: sha256(PAYLOAD),
			})
			expect(JSON.parse(await readFile(result.manifestPath, 'utf8'))).toEqual(result.manifest)
			// The intermediate tar does not stay beside the archive.
			await expect(stat(join(out, 'namzu-t2-base-2.tar'))).rejects.toThrow()
			expect(await tool.verifyManifest(result.manifestPath)).toEqual(result.manifest)
		} finally {
			await rm(out, { recursive: true, force: true })
		}
	})

	it.skipIf(typeof zlib.createZstdCompress !== 'function')(
		'compresses with zstd by default and keeps the bytes recoverable',
		async () => {
			const out = await mkdtemp(join(tmpdir(), 'namzu-build-image-zst-'))
			try {
				const options = tool.parseArguments(['--engine', 'docker', '--out', out, '--skip-build'])
				const result = await tool.buildImage(options, { run: fakeEngine().run })
				expect(result.manifest.format).toBe('zst')
				expect(result.archive.endsWith('namzu-local-computer-2.tar.zst')).toBe(true)
				const archive = await readFile(result.archive)
				expect(archive.subarray(0, 4).toString('hex')).toBe('28b52ffd')
				expect(zlib.zstdDecompressSync(archive).equals(PAYLOAD)).toBe(true)
				expect(archive.length).toBeLessThan(PAYLOAD.length)
			} finally {
				await rm(out, { recursive: true, force: true })
			}
		},
	)

	it('stores a plain tar as it is, and does not build with --skip-build', async () => {
		const out = await mkdtemp(join(tmpdir(), 'namzu-build-image-tar-'))
		try {
			const engine = fakeEngine()
			const options = tool.parseArguments([
				'--engine',
				'podman',
				'--out',
				out,
				'--format',
				'tar',
				'--skip-build',
			])
			const result = await tool.buildImage(options, { run: engine.run })
			expect(engine.commands.some((c) => c.args[0] === 'build')).toBe(false)
			expect(result.manifest).toMatchObject({
				format: 'tar',
				sizeBytes: PAYLOAD.length,
				compressedBytes: PAYLOAD.length,
				file: 'namzu-local-computer-2.tar',
			})
			expect(result.manifest.sha256).toBe(result.manifest.tarSha256)
		} finally {
			await rm(out, { recursive: true, force: true })
		}
	})

	it('refuses an image without the protocol label, and reports a failed engine step', async () => {
		const out = await mkdtemp(join(tmpdir(), 'namzu-build-image-bad-'))
		try {
			const options = tool.parseArguments(['--engine', 'docker', '--out', out, '--skip-build'])
			await expect(
				tool.buildImage(options, { run: fakeEngine({ labels: {} }).run }),
			).rejects.toThrow(`has no ${tool.PROTOCOL_LABEL} label`)
			await expect(
				tool.buildImage(
					{ ...options, skipBuild: false },
					{ run: fakeEngine({ failOn: 'build' }).run },
				),
			).rejects.toThrow('docker build failed (1): build exploded')
		} finally {
			await rm(out, { recursive: true, force: true })
		}
	})

	it('detects an archive that no longer matches its manifest', async () => {
		const out = await mkdtemp(join(tmpdir(), 'namzu-build-image-verify-'))
		try {
			const options = tool.parseArguments([
				'--engine',
				'docker',
				'--out',
				out,
				'--format',
				'gz',
				'--skip-build',
			])
			const result = await tool.buildImage(options, { run: fakeEngine().run })
			const archive = await readFile(result.archive)
			archive[archive.length - 1] = (archive[archive.length - 1] as number) ^ 0xff
			await writeFile(result.archive, archive)
			await expect(tool.verifyManifest(result.manifestPath)).rejects.toThrow(
				'does not match the manifest sha256',
			)
		} finally {
			await rm(out, { recursive: true, force: true })
		}
	})
})

describe('build-image command line', () => {
	it('exits 2 on bad arguments, 1 on a failed engine and 0 with a JSON manifest line', async () => {
		const out = await mkdtemp(join(tmpdir(), 'namzu-build-image-main-'))
		try {
			expect(await tool.main(['--bogus'], { run: fakeEngine().run })).toBe(2)
			expect(
				await tool.main(['--engine', 'docker', '--out', out], {
					run: fakeEngine({ failOn: 'build' }).run,
				}),
			).toBe(1)
			expect(
				await tool.main(['--engine', 'docker', '--out', out, '--format', 'tar', '--skip-build'], {
					run: fakeEngine().run,
				}),
			).toBe(0)
		} finally {
			await rm(out, { recursive: true, force: true })
		}
	})
})
