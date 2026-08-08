import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runDoctorCommand } from './doctor.js'

describe('runDoctorCommand', () => {
	let captured: string
	let originalStdoutWrite: typeof process.stdout.write
	let originalStderrWrite: typeof process.stderr.write

	beforeEach(() => {
		captured = ''
		originalStdoutWrite = process.stdout.write.bind(process.stdout)
		originalStderrWrite = process.stderr.write.bind(process.stderr)
		process.stdout.write = ((chunk: string | Uint8Array): boolean => {
			captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
			return true
		}) as typeof process.stdout.write
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
			return true
		}) as typeof process.stderr.write
	})

	afterEach(() => {
		process.stdout.write = originalStdoutWrite
		process.stderr.write = originalStderrWrite
		vi.unstubAllEnvs()
	})

	it('indents every line of a multi-line message under its check', async () => {
		// The provider chain prints one line per member. Rendered as a single
		// string, only the first line took the report's indent and the rest
		// broke out to column 0, so the report looked like it had ended and the
		// members read as stray output from something else.
		const home = mkdtempSync(join(tmpdir(), 'namzu-doctor-'))
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(
			join(home, '.namzu', 'preferences.json'),
			JSON.stringify({ version: 3, providers: [{ id: 'anthropic' }, { id: 'openai' }] }),
		)
		vi.stubEnv('HOME', home)
		vi.stubEnv('USERPROFILE', home)

		await runDoctorCommand(['--category', 'providers'])

		const memberLines = captured.split('\n').filter((l) => /^\s*\d+\. (primary|fallback)/.test(l))
		expect(memberLines).toHaveLength(2)
		for (const line of memberLines) {
			expect(line.startsWith('     ')).toBe(true)
		}
	})

	it('--help returns 0 and prints usage', async () => {
		const code = await runDoctorCommand(['--help'])
		expect(code).toBe(0)
		expect(captured).toContain('namzu doctor')
		expect(captured).toContain('--json')
		expect(captured).toContain('--category')
	})

	it('rejects unknown options with EXIT_USAGE (70)', async () => {
		const code = await runDoctorCommand(['--frobnicate'])
		expect(code).toBe(64)
		expect(captured).toContain('unknown option: --frobnicate')
	})

	it('--category accepts a valid comma-separated list', async () => {
		const code = await runDoctorCommand(['--category', 'sandbox,runtime', '--json'])
		expect([0, 1]).toContain(code)
		const json = JSON.parse(captured)
		expect(
			json.checks.every((c: { category: string }) => ['sandbox', 'runtime'].includes(c.category)),
		).toBe(true)
	})

	it('--category rejects an invalid name', async () => {
		const code = await runDoctorCommand(['--category', 'sandbox,wat'])
		expect(code).toBe(64)
		expect(captured).toContain('unknown category: wat')
	})

	it('--per-check-timeout requires a positive integer', async () => {
		const code = await runDoctorCommand(['--per-check-timeout', '-5'])
		expect(code).toBe(64)
		expect(captured).toContain('--per-check-timeout must be a positive integer')
	})

	it('--json emits valid JSON conforming to DoctorReport', async () => {
		const code = await runDoctorCommand(['--json'])
		expect([0, 1]).toContain(code)
		const json = JSON.parse(captured)
		expect(json).toHaveProperty('version')
		expect(json).toHaveProperty('timestamp')
		expect(Array.isArray(json.checks)).toBe(true)
		expect(json).toHaveProperty('summary.total')
		expect(json).toHaveProperty('exit')
	})

	it('default human output includes the summary line', async () => {
		const code = await runDoctorCommand([])
		expect([0, 1]).toContain(code)
		expect(captured).toContain('namzu doctor —')
		expect(captured).toMatch(/pass: \d+ {2}fail: \d+/)
		expect(captured).toMatch(/exit: \d+/)
	})

	it('built-in checks register with stable ids', async () => {
		const code = await runDoctorCommand(['--json'])
		expect([0, 1]).toContain(code)
		const json = JSON.parse(captured)
		const ids = json.checks.map((c: { id: string }) => c.id).sort()
		expect(ids).toContain('sandbox.platform')
		expect(ids).toContain('runtime.cwd-writable')
		expect(ids).toContain('runtime.tmpdir-writable')
		expect(ids).toContain('telemetry.installed')
		expect(ids).toContain('vault.registered')
		expect(ids).toContain('providers.registered')
	})
})
