import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

type Options = {
	out: string
	pythonArchive?: string
	palComputerImage?: string
	palComputerManifest?: string
}
const staging = (await import(
	/* @vite-ignore */ new URL('../../scripts/stage-installer.mjs', import.meta.url).href
)) as {
	parseArguments: (args: string[]) => Options
	stagePalComputer: (
		out: string,
		image: string | undefined,
		manifest: string | undefined,
	) => Record<string, unknown> | undefined
}

const folders: string[] = []
function scratch(): string {
	const folder = mkdtempSync(join(tmpdir(), 'namzu-stage-test-'))
	folders.push(folder)
	return folder
}
afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** An archive and a manifest that describe it, as build-image.mjs writes them. */
function image(folder: string, overrides: Record<string, unknown> = {}) {
	const bytes = Buffer.from('not really a tarball '.repeat(100))
	const file = join(folder, 'namzu-local-computer-2.tar.zst')
	writeFileSync(file, bytes)
	const manifest = {
		revision: 2,
		imageRef: 'namzu-local-computer:2',
		imageId: `sha256:${'cd'.repeat(32)}`,
		protocol: '1',
		sha256: createHash('sha256').update(bytes).digest('hex'),
		sizeBytes: bytes.length * 3,
		compressedBytes: bytes.length,
		format: 'zst',
		file: 'namzu-local-computer-2.tar.zst',
		...overrides,
	}
	const manifestFile = join(folder, 'manifest.json')
	writeFileSync(manifestFile, JSON.stringify(manifest))
	return { file, manifestFile, manifest }
}

describe('stage-installer flags', () => {
	it('keeps the existing usage: one folder, optionally a Python archive', () => {
		expect(parseOut(['stage'])).toBe(resolve('stage'))
		expect(staging.parseArguments(['stage', '--python-archive', 'p.tar.gz'])).toMatchObject({
			out: resolve('stage'),
			pythonArchive: resolve('p.tar.gz'),
			palComputerImage: undefined,
		})
	})

	it('takes the Pal computer image and finds its manifest beside it', () => {
		const options = staging.parseArguments(['--pal-computer-image', 'dir/a.tar.zst', 'stage'])
		expect(options.palComputerImage).toBe(resolve('dir/a.tar.zst'))
		expect(options.palComputerManifest).toBe(resolve('dir/manifest.json'))
		expect(
			staging.parseArguments([
				'stage',
				'--pal-computer-image',
				'a.tar.zst',
				'--pal-computer-manifest',
				'other/m.json',
			]).palComputerManifest,
		).toBe(resolve('other/m.json'))
	})

	it.each([
		[[], 'Usage: stage-installer.mjs'],
		[['a', 'b'], 'Usage: stage-installer.mjs'],
		[['stage', '--pal-computer-image'], '--pal-computer-image needs a file'],
		[
			['stage', '--pal-computer-image', '--python-archive', 'p'],
			'--pal-computer-image needs a file',
		],
		[['stage', '--pal-computer-manifest', 'm.json'], 'needs --pal-computer-image'],
	])('rejects %j', (args, message) => {
		expect(() => staging.parseArguments(args as string[])).toThrow(message as string)
	})
})

function parseOut(args: string[]): string {
	return staging.parseArguments(args).out
}

describe('stage-installer Pal computer image', () => {
	it('copies the archive and the manifest into extra/pal-computer, byte for byte', () => {
		const source = scratch()
		const out = scratch()
		const { file, manifestFile, manifest } = image(source)
		expect(staging.stagePalComputer(out, file, manifestFile)).toEqual(manifest)
		const target = join(out, 'extra/pal-computer')
		expect(readdirSync(target).sort()).toEqual(['manifest.json', 'namzu-local-computer-2.tar.zst'])
		expect(readFileSync(join(target, manifest.file))).toEqual(readFileSync(file))
		expect(JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8'))).toEqual(manifest)
	})

	it('leaves a marker, and no manifest, when the build carries no image', () => {
		const out = scratch()
		expect(staging.stagePalComputer(out, undefined, undefined)).toBeUndefined()
		expect(readdirSync(join(out, 'extra/pal-computer'))).toEqual(['README.txt'])
	})

	it('refuses an archive that does not match its manifest', () => {
		const source = scratch()
		const out = scratch()
		const wrongHash = image(source, { sha256: '00'.repeat(32) })
		expect(() => staging.stagePalComputer(out, wrongHash.file, wrongHash.manifestFile)).toThrow(
			'does not match the manifest sha256',
		)
		const wrongSize = image(source, { compressedBytes: 5 })
		expect(() => staging.stagePalComputer(out, wrongSize.file, wrongSize.manifestFile)).toThrow(
			'is not 5 bytes',
		)
		const wrongName = image(source, { file: 'other.tar.zst' })
		expect(() => staging.stagePalComputer(out, wrongName.file, wrongName.manifestFile)).toThrow(
			'describes other.tar.zst',
		)
		const missingKey = image(source, { imageId: undefined })
		expect(() => staging.stagePalComputer(out, missingKey.file, missingKey.manifestFile)).toThrow(
			'has no "imageId"',
		)
		expect(readdirSync(join(out, 'extra/pal-computer'))).toEqual([])
	})

	it('names a missing file', () => {
		const out = scratch()
		const missing = join(scratch(), 'none.tar.zst')
		mkdirSync(join(out, 'extra'), { recursive: true })
		expect(() => staging.stagePalComputer(out, missing, join(out, 'm.json'))).toThrow(
			'none.tar.zst does not exist',
		)
	})
})
