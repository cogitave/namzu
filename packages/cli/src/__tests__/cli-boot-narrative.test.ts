import { describe, expect, it } from 'vitest'

import { type LogRecord, installProcessSink } from '@namzu/sdk'

import { emitBootNarrative } from '../cli.js'
import type { ConfigProvenance } from '../config/load.js'
import { DEFAULT_CONFIG } from '../config/schema.js'

/**
 * The CLI-process third of the boot narrative — `namzu.boot.start`,
 * `namzu.config.resolved`, `namzu.telemetry.status` — is `getContext()`'s,
 * not `createAgentSession`'s: `doctor` and `login` never build an agent
 * session and still need to say what they resolved. See
 * `packages/cli/src/tui/__tests__/boot-narrative.test.ts` for the other six
 * event names, which DO require a session.
 */

function capturingSink(): LogRecord[] {
	const records: LogRecord[] = []
	installProcessSink({ emit: (r) => records.push(r) }, 'debug', { replace: true })
	return records
}

describe('emitBootNarrative', () => {
	it('names exactly the three events this file owns, and no other', () => {
		const records = capturingSink()
		const provenance: ConfigProvenance = {
			format: { kind: 'default' },
			quiet: { kind: 'env', variable: 'NAMZU_QUIET' },
		}
		emitBootNarrative(provenance, { ...DEFAULT_CONFIG, format: 'text', quiet: false })

		const names = new Set(records.map((r) => r.eventName).filter((n): n is string => Boolean(n)))
		expect(names).toEqual(
			new Set(['namzu.boot.start', 'namzu.config.resolved', 'namzu.telemetry.status']),
		)
	})

	it('summarizes the source breakdown at info, one key per declared source', () => {
		const records = capturingSink()
		emitBootNarrative(
			{ format: { kind: 'default' }, quiet: { kind: 'env', variable: 'NAMZU_QUIET' } },
			{ ...DEFAULT_CONFIG, format: 'text', quiet: true },
		)
		const summary = records.find(
			(r) => r.eventName === 'namzu.config.resolved' && r.severityText === 'info',
		)
		expect(summary?.body).toContain('2 keys')
		expect(summary?.body).toContain('default(1)')
		expect(summary?.body).toContain('env(1)')
	})

	it('reports each resolved key at debug, naming which source won it', () => {
		const records = capturingSink()
		emitBootNarrative(
			{ quiet: { kind: 'env', variable: 'NAMZU_QUIET' } },
			{ ...DEFAULT_CONFIG, quiet: true },
		)
		const row = records.find(
			(r) => r.eventName === 'namzu.config.resolved' && r.severityText === 'debug',
		)
		expect(row?.attributes['namzu.config.key']).toBe('quiet')
		expect(row?.attributes['namzu.config.source']).toBe('env NAMZU_QUIET')
	})

	it('never emits a debug row for a key no source actually set', () => {
		// `provenance` can omit a key `DEFAULT_CONFIG` still carries — see
		// ConfigProvenance's own doc comment. Fabricating a row for it would
		// misreport an unset key as resolved by something.
		const records = capturingSink()
		emitBootNarrative({}, DEFAULT_CONFIG)
		const rows = records.filter((r) => r.severityText === 'debug')
		expect(rows).toHaveLength(0)
	})

	it('states plainly that no tracer/logger provider is registered', () => {
		const records = capturingSink()
		emitBootNarrative({}, DEFAULT_CONFIG)
		const status = records.find((r) => r.eventName === 'namzu.telemetry.status')
		expect(status?.severityText).toBe('info')
		// The message names the two OTel providers and, more usefully, the
		// consequence: `trace_id will be absent from every record`. An operator
		// reading a log with no trace ids needs to know that is a configuration
		// state and not a bug, which "not registered" alone does not tell them.
		expect(status?.body).toContain('registered')
		expect(status?.body, 'the consequence is what makes this row worth a line').toContain(
			'trace_id will be absent',
		)
		expect(status?.attributes['namzu.telemetry.registered']).toBe(false)
	})
})
