import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LogRecord } from '@namzu/sdk'
import { installProcessSink } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { emitBootNarrative } from '../../../cli.js'
import { loadConfigWithProvenance } from '../../../config/load.js'
import { DEFAULT_CONFIG } from '../../../config/schema.js'
import { describeSessionExportStatus } from '../../../doctor/checks/session-export.js'
import {
	SessionExportUnavailableError,
	attachSessionExport,
	describeSessionExportOff,
	fileSink,
	loadTelemetryFrom,
} from '../session-export.js'

/**
 * The CLI half of session export: the config a user writes, the refusal when
 * the package that would do the work is absent, and the two places the
 * disclosure has to be readable.
 *
 * `@namzu/telemetry` is a real workspace package here, so these could import
 * it directly. They inject a loader instead, because the property under test
 * is what this CLI does when the package is NOT there — and there is no way
 * to uninstall a workspace dependency from inside a test run.
 */

type Loader = () => Promise<never>

const absent: Loader = () => {
	throw new SessionExportUnavailableError('absent')
}

async function realTelemetry() {
	return (await import('@namzu/telemetry')) as never
}

describe('a configured export whose package is missing', () => {
	it('refuses rather than running a session that records nothing', async () => {
		await expect(
			attachSessionExport({
				config: { destination: '/tmp/does-not-matter.jsonl' },
				loader: absent,
			}),
		).rejects.toThrow(SessionExportUnavailableError)
	})

	it('names both ways out in the message', async () => {
		// The refusal an operator reads at 2am. Naming only "install it" leaves
		// somebody who does not want export at all with no way forward.
		const err = await attachSessionExport({
			config: { destination: '/tmp/x.jsonl' },
			loader: absent,
		}).then(
			() => null,
			(e: unknown) => e as Error,
		)
		expect(err).toBeInstanceOf(SessionExportUnavailableError)
		if (!err) throw new Error('unreachable')

		expect(err.message).toContain('@namzu/telemetry')
		expect(err.message).toContain('npm i @namzu/telemetry')
		expect(err.message).toContain('remove telemetry.sessionExport')
	})

	it('produces the refusal from a specifier that genuinely does not resolve', async () => {
		// The real resolution path, not an injected loader. Everything else here
		// hands `attachSessionExport` a loader that already throws, which proves
		// what it does with a refusal and nothing about where one comes from —
		// a mutation replacing the `absent` throw with a stub module survived
		// until this test existed.
		await expect(loadTelemetryFrom('@namzu/definitely-not-a-real-package')).rejects.toThrow(
			SessionExportUnavailableError,
		)
	})

	it('resolves the real package, so the check above can fail in both directions', async () => {
		// Without this, `loadTelemetryFrom` throwing unconditionally would pass
		// the test above — a check that cannot fail.
		const mod = await loadTelemetryFrom('@namzu/telemetry')
		expect(typeof mod.createSessionExportListener).toBe('function')
	})

	it('is silent when export was never configured', async () => {
		// The ordinary case: no export asked for, package not installed. There
		// is nothing to disclose, and inventing a sentence would be noise on
		// every boot of a CLI that exports nothing.
		expect(await describeSessionExportOff(absent as never)).toBeNull()
	})
})

describe('the redaction default', () => {
	it('installs the shipped redactor when `redactors` is omitted', async () => {
		const records: unknown[] = []
		const attached = await attachSessionExport({
			config: { destination: 'unused' },
			loader: realTelemetry,
			sink: { emit: (r) => records.push(r), shutdown: async () => {} },
		})

		expect(attached.disclosure).toContain('1 redactor')
	})

	it('installs none only when the config says `[]` explicitly', async () => {
		const attached = await attachSessionExport({
			config: { destination: 'unused', redactors: [] },
			loader: realTelemetry,
			sink: { emit: () => {}, shutdown: async () => {} },
		})

		// Reaching "no redaction" takes an explicit empty array. Forgetting the
		// key gets the redactor, which is the asymmetry this default exists for.
		expect(attached.disclosure).toContain('no redactors are installed')
	})
})

describe('the file sink', () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'namzu-session-export-'))
	})
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	it('writes one JSON record per line, creating the directory', () => {
		const path = join(dir, 'nested', 'session.jsonl')
		const sink = fileSink(path)
		sink.emit({ event: { type: 'text_delta' }, at: 1 })
		sink.emit({ event: { type: 'run_completed' }, at: 2 })

		const lines = readFileSync(path, 'utf-8').trimEnd().split('\n')
		expect(lines).toHaveLength(2)
		expect(JSON.parse(lines[0] as string)).toMatchObject({ event: { type: 'text_delta' } })
		expect(JSON.parse(lines[1] as string)).toMatchObject({ event: { type: 'run_completed' } })
	})
})

describe('the config reader', () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'namzu-export-config-'))
	})
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	function write(body: unknown): void {
		writeFileSync(join(dir, 'namzu.config.json'), JSON.stringify(body))
	}

	function read() {
		return loadConfigWithProvenance({ cwd: dir, env: {}, home: dir }).config.telemetry
	}

	it('reads a well-formed sessionExport', () => {
		write({ telemetry: { sessionExport: { destination: 'out.jsonl', redactors: ['secrets'] } } })
		expect(read()?.sessionExport).toEqual({ destination: 'out.jsonl', redactors: ['secrets'] })
	})

	it('drops the WHOLE sessionExport when `redactors` is malformed', () => {
		write({ telemetry: { sessionExport: { destination: 'out.jsonl', redactors: 'secrets' } } })

		// Not "drop the bad key and keep exporting". A misspelled or mistyped
		// `redactors` read leniently would leave export ON with redaction
		// silently OFF — the one outcome a config typo must not be able to
		// produce. Dropping it entirely makes the boot line read "off", which
		// is visible.
		expect(read()?.sessionExport).toBeUndefined()
	})

	it('drops it when the destination is missing or empty', () => {
		write({ telemetry: { sessionExport: { redactors: ['secrets'] } } })
		expect(read()?.sessionExport).toBeUndefined()
		write({ telemetry: { sessionExport: { destination: '' } } })
		expect(read()?.sessionExport).toBeUndefined()
	})

	it('drops it for an unknown redactor name', () => {
		write({ telemetry: { sessionExport: { destination: 'out.jsonl', redactors: ['everything'] } } })
		expect(read()?.sessionExport).toBeUndefined()
	})
})

function capturingSink(): LogRecord[] {
	const records: LogRecord[] = []
	installProcessSink({ emit: (r) => records.push(r) }, 'debug', { replace: true })
	return records
}

describe('the boot narrative', () => {
	it('says export is off when nothing is configured', () => {
		const records = capturingSink()
		emitBootNarrative({ format: { kind: 'default' } }, { ...DEFAULT_CONFIG })

		const status = records.find((r) => r.eventName === 'namzu.telemetry.status')
		expect(status?.attributes['namzu.telemetry.session_export']).toBe(false)
	})

	it('says export is on when it is configured', () => {
		const records = capturingSink()
		emitBootNarrative(
			{ format: { kind: 'default' } },
			{ ...DEFAULT_CONFIG, telemetry: { sessionExport: { destination: 'out.jsonl' } } },
		)

		const status = records.find((r) => r.eventName === 'namzu.telemetry.status')
		// Present in BOTH states, so "off" is a stated fact rather than the
		// absence of a claim — an operator reading the boot log for this
		// question gets an answer either way.
		expect(status?.attributes['namzu.telemetry.session_export']).toBe(true)
	})
})

describe('the doctor row', () => {
	it('names the destination and the redactor count when export is on', async () => {
		const result = await describeSessionExportStatus(
			{ telemetry: { sessionExport: { destination: '/var/log/namzu/session.jsonl' } } },
			realTelemetry,
		)

		expect(result.status).toBe('pass')
		expect(result.message).toContain('/var/log/namzu/session.jsonl')
		expect(result.message).toContain('1 redactor')
		expect(result.message).toContain('every run event')
	})

	it('is a pass, not a warning, when export is on', async () => {
		// Export being on is a configuration somebody chose, not a fault.
		// Reporting it as a warning would train a reader to skip past the one
		// row that describes their data leaving the machine.
		const on = await describeSessionExportStatus(
			{ telemetry: { sessionExport: { destination: 'x.jsonl' } } },
			realTelemetry,
		)
		expect(on.status).toBe('pass')
	})

	it('carries a remediation when redaction was explicitly turned off', async () => {
		const result = await describeSessionExportStatus(
			{ telemetry: { sessionExport: { destination: 'x.jsonl', redactors: [] } } },
			realTelemetry,
		)

		expect(result.status).toBe('pass')
		expect(result.message).toContain('0 redactor')
		expect(result.remediation).toContain('verbatim')
	})

	it('FAILS when export is configured and the package is absent', async () => {
		const result = await describeSessionExportStatus(
			{ telemetry: { sessionExport: { destination: 'x.jsonl' } } },
			absent as never,
		)

		// The run refuses in this state. A doctor that reported `pass` would
		// send an operator into a run that cannot start.
		expect(result.status).toBe('fail')
		expect(result.remediation).toContain('@namzu/telemetry')
	})

	it('reads differently on and off', async () => {
		const off = await describeSessionExportStatus({}, realTelemetry)
		const on = await describeSessionExportStatus(
			{ telemetry: { sessionExport: { destination: 'x.jsonl' } } },
			realTelemetry,
		)
		expect(off.message).not.toBe(on.message)
		expect(off.message).toContain('off')
	})
})
