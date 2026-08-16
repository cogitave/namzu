import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NOOP_SINK, installProcessSink } from '@namzu/sdk'

import { runDoctorCommand } from './doctor.js'

describe('runDoctorCommand', () => {
	let captured: string
	let originalStdoutWrite: typeof process.stdout.write
	let originalStderrWrite: typeof process.stderr.write

	beforeEach(() => {
		// `cli.ts` claims the process's log destination for EVERY invocation,
		// before it dispatches to a subcommand — its own comment names
		// `doctor` as the reason. These tests call `runDoctorCommand`
		// directly, so without this line they run a doctor in a state no real
		// invocation reaches, and `logging.pipeline` correctly reports it as
		// unmeasured (exit 69). `fixture-must-match-production`: the harness
		// installs a sink because production always has.
		installProcessSink(NOOP_SINK, 'silent', { replace: true })
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

	it('counts every status in the summary line, and the row sums to the total', async () => {
		// `skipped` had no column while it was folded into `inconc`, so the line
		// reported an optional package's absence in the same figure as a check
		// that timed out — and a reader adding the row up got the right total for
		// the wrong reason.
		await runDoctorCommand([])
		const row = captured.split('\n').find((l) => l.includes('pass:'))
		expect(row, 'the summary line is missing').toBeDefined()
		const n = (key: string) =>
			Number(new RegExp(`${key}: (\\d+)`).exec(row ?? '')?.[1] ?? Number.NaN)
		const parts = ['pass', 'fail', 'warn', 'inconc', 'skipped'].map(n)
		expect(parts.some(Number.isNaN), `a column is missing from: ${row}`).toBe(false)
		expect(parts.reduce((a, b) => a + b, 0)).toBe(n('total'))
	})

	it('gives a skipped row its own mark, distinct from a check that could not answer', async () => {
		// `vault.registered` and `providers.registered` are skipped on every
		// machine — there is no discovery mechanism for either — so the built-in
		// suite always has one to render.
		await runDoctorCommand([])
		const skippedRow = captured.split('\n').find((l) => l.includes('vault.registered'))
		expect(skippedRow, 'the vault row is missing').toBeDefined()
		expect(skippedRow ?? '').toContain('⊘')
		expect(skippedRow ?? '', 'a skipped row is marked as unanswered').not.toContain('?')
	})

	it('exits non-zero exactly when a check could not answer', async () => {
		// The whole of #310 as one property, asserted against the REAL built-in
		// suite rather than a hand-built registry: on an ordinary machine nothing
		// is inconclusive and the command must exit 0, and the moment something
		// is, it must not.
		const code = await runDoctorCommand(['--json'])
		const json = JSON.parse(captured)
		const unanswered = json.checks.filter(
			(c: { status: string }) => c.status === 'inconclusive',
		).length
		expect(json.summary.inconclusive).toBe(unanswered)
		if (json.summary.fail > 0) {
			expect(code).toBe(1)
		} else {
			expect(code).toBe(unanswered > 0 ? 69 : 0)
		}
	})

	it('never reports the checks that have nothing to look at as unanswered', async () => {
		// The regression this change could have introduced. Both of these are
		// unconditional by design — there is no vault or provider auto-discovery
		// to fail — so calling them `inconclusive` would have made `namzu doctor`
		// exit 69 on every healthy machine, which is the way to get a diagnostic
		// switched off.
		await runDoctorCommand(['--json'])
		const json = JSON.parse(captured)
		const byId = new Map<string, string>(
			json.checks.map((c: { id: string; status: string }) => [c.id, c.status]),
		)
		expect(byId.get('vault.registered')).toBe('skipped')
		expect(byId.get('providers.registered')).toBe('skipped')
		expect(['pass', 'skipped', 'fail']).toContain(byId.get('telemetry.installed'))
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
