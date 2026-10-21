import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { type NativeAnalysis, createNativeAnalysis } from '../client.js'
import { NativeAnalysisError } from '../errors.js'
import { bunPayload, elf, noteRecord, seaBlob, sha256 } from './fixtures.js'
import { describeNative, sidecar } from './native.js'

const workDir = mkdtempSync(join(tmpdir(), 'analysis-native-'))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))

function write(name: string, data: Buffer | string): string {
	const p = join(workDir, name)
	writeFileSync(p, data)
	return p
}

/** A small system ELF, or Node itself, which exists wherever the tests run. */
const system = existsSync('/usr/bin/ls') ? '/usr/bin/ls' : process.execPath

describeNative('native analysis sidecar', () => {
	let native: NativeAnalysis
	beforeAll(() => {
		native = createNativeAnalysis({ binaryPath: sidecar?.path })
	})
	afterAll(async () => {
		await native.close()
	})

	it('says hello', async () => {
		const hello = await native.hello()
		expect(hello.name).toBe('namzu-analysis-native')
		expect(hello.protocol).toBe(1)
		expect(hello.ops).toEqual(
			expect.arrayContaining([
				'binary_info',
				'symbols',
				'imports',
				'exports',
				'strings',
				'extract_embedded',
			]),
		)
		expect(hello.embedded).toEqual(['bun', 'node-sea'])
	})

	it('describes a system executable', async () => {
		const info = await native.binaryInfo({ path: system })
		expect(info.parsed).toBe(true)
		expect(['elf', 'pe', 'macho', 'macho-fat']).toContain(info.format)
		expect(info.sections?.length).toBeGreaterThan(3)
		expect(info.entry).toBeGreaterThan(0)
	})

	it('pages symbols, imports and strings of a system executable', async () => {
		const symbols = await native.symbols({ path: system, limit: 5 })
		expect(symbols.symbols.length).toBeLessThanOrEqual(5)
		expect(symbols.total).toBeGreaterThan(0)
		const imports = await native.imports({ path: system, limit: 5 })
		expect(imports.libraries.length).toBeGreaterThan(0)
		const strings = await native.strings({ path: system, limit: 3, minLength: 6 })
		expect(strings.strings.length).toBe(3)
		for (const s of strings.strings) expect(s.length).toBeGreaterThanOrEqual(6)
		await native.exports({ path: system, limit: 5 })
	})

	it('demangles and filters symbols of a synthetic ELF', async () => {
		const path = write('syms.o', elf([{ name: '.text', data: Buffer.alloc(16, 0x90), flags: 6 }]))
		const found = await native.symbols({ path, contains: 'foo::bar' })
		expect(found.total).toBe(1)
		expect(found.symbols[0]).toMatchObject({
			raw: '_ZN3foo3barEi',
			name: 'foo::bar(int)',
			language: 'cpp',
		})
	})

	it('relative paths are resolved against the caller, not the sidecar', async () => {
		const path = write('rel.bin', 'plain text for the strings op')
		const rel = join(workDir, '.', 'rel.bin')
		const out = await native.strings({ path: rel })
		expect(out.strings[0]?.text).toContain('plain text')
		expect(path).toBeTruthy()
	})

	it('extracts a Bun payload with provenance, and the files are where it says', async () => {
		const binary = elf([
			{
				name: '.bun',
				data: bunPayload([
					{ name: '/$bunfs/root/cli.js', contents: 'console.log("cli")' },
					{ name: '/$bunfs/root/lib/util.js', contents: 'export const x = 1' },
					{ name: '/$bunfs/root/data.json', contents: '{"a":1}', loader: 6 },
				]),
			},
		])
		const path = write('bun-app', binary)
		const outDir = join(workDir, 'bun-out')
		const result = await native.extractEmbedded({ path, outDir })
		expect(result.kind).toBe('bun')
		expect(result.written).toBe(3)
		expect(result.outDir).toBe(outDir)
		expect(result.embeddedProvenance).toMatchObject({
			sourcePath: path,
			sourceSha256: sha256(binary),
			sourceSize: binary.length,
			format: 'elf',
			kind: 'bun',
		})
		expect(result.embeddedProvenance.sidecarVersion).toMatch(/^\d+\.\d+\.\d+/)
		expect(readFileSync(join(outDir, 'cli.js'), 'utf8')).toBe('console.log("cli")')
		expect(readFileSync(join(outDir, 'lib', 'util.js'), 'utf8')).toBe('export const x = 1')
		const record = JSON.parse(readFileSync(join(outDir, '.namzu-provenance.json'), 'utf8'))
		expect(record.sourceSha256).toBe(sha256(binary))
		const info = await native.binaryInfo({ path })
		expect(info.embedded[0]).toMatchObject({ kind: 'bun', valid: true, modules: 3 })
	})

	it('refuses a Bun payload whose lengths lie, writing nothing', async () => {
		const payload = bunPayload([{ name: '/$bunfs/root/a.js', contents: 'x' }])
		payload.writeBigUInt64LE(0xffffffffffffn, 0)
		const path = write('bun-bad', elf([{ name: '.bun', data: payload }]))
		const outDir = join(workDir, 'bun-bad-out')
		await expect(native.extractEmbedded({ path, outDir })).rejects.toMatchObject({
			code: 'extract_refused',
			message: expect.stringContaining('bun-standalone-52'),
		})
		expect(existsSync(outDir) ? readdirSync(outDir) : []).toEqual([])
	})

	it('never writes a hostile module name outside the output directory', async () => {
		const path = write(
			'bun-evil',
			elf([
				{
					name: '.bun',
					data: bunPayload([
						{ name: '/$bunfs/root/../../escaped.js', contents: 'x' },
						{ name: '/etc/absolute.js', contents: 'x' },
						{ name: '/$bunfs/root/nul\0byte.js', contents: 'x' },
						{ name: '/$bunfs/root/fine.js', contents: 'ok' },
					]),
				},
			]),
		)
		const sandbox = join(workDir, 'evil-parent')
		const outDir = join(sandbox, 'out')
		const result = await native.extractEmbedded({ path, outDir })
		expect(result.written).toBe(1)
		expect(result.skipped).toBe(3)
		expect(readdirSync(sandbox)).toEqual(['out'])
		expect(readdirSync(outDir).sort()).toEqual(['.namzu-provenance.json', 'fine.js'])
	})

	it('does not let a payload module take the name of the provenance record', async () => {
		const path = write(
			'bun-provenance',
			elf([
				{
					name: '.bun',
					data: bunPayload([
						{ name: '/$bunfs/root/.namzu-provenance.json', contents: '{"forged":true}' },
						{ name: '/$bunfs/root/fine.js', contents: 'ok' },
					]),
				},
			]),
		)
		const outDir = join(workDir, 'provenance-out')
		const result = await native.extractEmbedded({ path, outDir })
		expect(result.written).toBe(1)
		expect(result.skipped).toBe(1)
		const record = JSON.parse(readFileSync(join(outDir, '.namzu-provenance.json'), 'utf8'))
		expect(record.forged).toBeUndefined()
		expect(record.sourceSha256).toBe(result.provenance.sourceSha256)
	})

	it('extracts a Node SEA blob from an ELF note', async () => {
		const blob = seaBlob('main.js', 'console.log("sea")', { 'a.txt': 'asset' })
		const path = write(
			'sea-app',
			elf([{ name: '.note.sea', type: 7, data: noteRecord('NODE_SEA_BLOB', blob) }]),
		)
		const outDir = join(workDir, 'sea-out')
		const result = await native.extractEmbedded({ path, outDir })
		expect(result.kind).toBe('node-sea')
		expect(readFileSync(join(outDir, 'main', 'main.js'), 'utf8')).toBe('console.log("sea")')
		expect(readFileSync(join(outDir, 'assets', 'a.txt'), 'utf8')).toBe('asset')
		expect(readFileSync(join(outDir, 'sea-blob.bin')).equals(blob)).toBe(true)
	})

	it('reports sidecar errors with their code and keeps serving', async () => {
		await expect(native.request('no_such_op')).rejects.toMatchObject({ code: 'unknown_op' })
		await expect(native.binaryInfo({ path: join(workDir, 'missing') })).rejects.toMatchObject({
			code: 'file_error',
		})
		await expect(native.binaryInfo({ path: workDir })).rejects.toMatchObject({
			code: 'not_regular_file',
		})
		await expect(native.request('symbols', { path: system, bogus: true })).rejects.toBeInstanceOf(
			NativeAnalysisError,
		)
		// The same process still answers.
		expect((await native.hello()).protocol).toBe(1)
	})

	it('answers queued requests in order and with the right payloads', async () => {
		const files = Array.from({ length: 12 }, (_, i) => write(`q${i}.txt`, `needle-number-${i}`))
		const results = await Promise.all(files.map((path) => native.strings({ path })))
		results.forEach((r, i) => {
			expect(r.strings[0]?.text).toBe(`needle-number-${i}`)
		})
	})

	it('a result is bounded by maxBytes and says how to continue', async () => {
		const path = write(
			'lots.txt',
			Array.from({ length: 4000 }, (_, i) => `a-moderately-long-string-${i}`).join('\0'),
		)
		const page = await native.strings({ path, limit: 20000 }, { maxBytes: 4096 })
		expect(page.complete).toBe(false)
		expect(page.strings.length).toBeLessThan(100)
		expect(page.nextCursor).not.toBeNull()
		const next = await native.strings({ path, cursor: page.nextCursor ?? 0, limit: 5 })
		expect(next.strings[0]?.text).toBe(`a-moderately-long-string-${page.strings.length}`)
	})

	it('a deadline of zero stops a scan cooperatively', async () => {
		const path = write('scan.bin', Buffer.alloc(1 << 20, 0x41))
		await expect(native.strings({ path }, { deadlineMs: 0 })).rejects.toMatchObject({
			code: 'deadline_exceeded',
		})
		expect((await native.hello()).protocol).toBe(1)
	})

	it('copes with a path to a device', async () => {
		if (process.platform === 'win32') return
		await expect(native.binaryInfo({ path: '/dev/zero' })).rejects.toMatchObject({
			code: 'not_regular_file',
		})
	})
})

describeNative('a Windows and a macOS fixture', () => {
	let native: NativeAnalysis
	beforeAll(() => {
		native = createNativeAnalysis({ binaryPath: sidecar?.path })
	})
	afterAll(async () => {
		await native.close()
	})

	it('reads a handmade PE', async () => {
		const pe = Buffer.alloc(0x400)
		pe.write('MZ', 0)
		pe.writeUInt32LE(0x40, 0x3c)
		pe.write('PE\0\0', 0x40)
		pe.writeUInt16LE(0x8664, 0x44)
		pe.writeUInt16LE(0, 0x46)
		pe.writeUInt32LE(0x5f5e1000, 0x48)
		pe.writeUInt16LE(240, 0x44 + 16)
		pe.writeUInt16LE(0x22, 0x44 + 18)
		pe.writeUInt16LE(0x20b, 0x58)
		pe.writeUInt32LE(16, 0x58 + 108)
		const path = write('min.exe', pe)
		const info = await native.binaryInfo({ path })
		expect(info.format).toBe('pe')
		expect(info.arch).toBe('x86_64')
		expect(info.peTimestamp).toBe(0x5f5e1000)
	})

	it('reports an unrecognised file without failing', async () => {
		const info = await native.binaryInfo({ path: write('what.dat', 'just some text') })
		expect(info.format).toBe('unknown')
		expect(info.parsed).toBe(false)
		expect(info.embedded).toEqual([])
	})
})

const hasClaude = existsSync(join(process.env.HOME ?? '', '.local/share/claude/versions/2.1.306'))
const claudePath = join(process.env.HOME ?? '', '.local/share/claude/versions/2.1.306')

const local = sidecar
if (local && !process.env.CI && hasClaude) {
	describeNative('the Claude Code executable (local only)', () => {
		it('yields its JavaScript, and a sample parses', async () => {
			const native = createNativeAnalysis({ binaryPath: local.path })
			try {
				const outDir = join(workDir, 'claude-out')
				const result = await native.extractEmbedded({ path: claudePath, outDir, limit: 10 })
				expect(result.kind).toBe('bun')
				expect(result.moduleCount).toBeGreaterThan(2000)
				expect(result.written).toBeGreaterThanOrEqual(2000)
				const js = readdirSync(outDir, { recursive: true, withFileTypes: false })
					.map(String)
					.filter((f) => f.endsWith('.js'))
				expect(js.length).toBeGreaterThanOrEqual(2000)
				// `node --check` parses; it does not run the file.
				const step = Math.floor(js.length / 40)
				for (let i = 0; i < js.length; i += step) {
					execFileSync(process.execPath, ['--check', join(outDir, js[i] as string)], {
						stdio: 'pipe',
					})
				}
			} finally {
				await native.close()
			}
		})
	})
} else {
	// biome-ignore lint/suspicious/noConsole: the reason a test was skipped must reach the log
	console.warn(
		`[analysis-native] skipping the Claude Code extraction test: ${
			process.env.CI
				? 'CI is set (the 290 MB binary is not available there)'
				: hasClaude
					? 'the sidecar is not built'
					: `${claudePath} does not exist`
		}.`,
	)
}
