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
		// The breakdown moved out of the body and into attributes (LOG-21), so
		// the body is now a constant an operator can group by and every count
		// is a key a dashboard can read.
		//
		// TWO scenarios, and the counts within each are pairwise distinct on
		// purpose. The first version of this assertion used one key per source
		// — default 1, env 1 — and `'namzu.config.default_count': counts.env`
		// passed it: two counters holding the same number are one counter as
		// far as any assertion can tell. Five config keys cannot make four
		// POSITIVE counts distinct at once (that needs 1+2+3+4), so the four
		// sources are split across two calls, three-and-two each way.
		const summaryOf = (records: LogRecord[]) =>
			records.find((r) => r.eventName === 'namzu.config.resolved' && r.severityText === 'info')

		const fileRecords = capturingSink()
		emitBootNarrative(
			{
				format: { kind: 'default' },
				quiet: { kind: 'default' },
				permissions: { kind: 'default' },
				mcpServers: { kind: 'user-file', path: '/home/u/.namzu.json' },
				sandbox: { kind: 'user-file', path: '/home/u/.namzu.json' },
			},
			{ ...DEFAULT_CONFIG, format: 'text', quiet: true },
		)
		const fileSummary = summaryOf(fileRecords)
		expect(fileSummary?.body).toBe('Configuration resolved')
		expect(fileSummary?.attributes['namzu.config.key_count']).toBe(5)
		expect(fileSummary?.attributes['namzu.config.default_count']).toBe(3)
		expect(fileSummary?.attributes['namzu.config.user_file_count']).toBe(2)
		expect(fileSummary?.attributes['namzu.config.project_file_count']).toBe(0)
		expect(fileSummary?.attributes['namzu.config.env_count']).toBe(0)

		const envRecords = capturingSink()
		emitBootNarrative(
			{
				format: { kind: 'project-file', path: '/w/.namzu.json' },
				quiet: { kind: 'project-file', path: '/w/.namzu.json' },
				permissions: { kind: 'project-file', path: '/w/.namzu.json' },
				mcpServers: { kind: 'env', variable: 'NAMZU_MCP_SERVERS' },
				sandbox: { kind: 'env', variable: 'NAMZU_SANDBOX' },
			},
			{ ...DEFAULT_CONFIG, format: 'text', quiet: true },
		)
		const envSummary = summaryOf(envRecords)
		expect(envSummary?.body).toBe('Configuration resolved')
		expect(envSummary?.attributes['namzu.config.key_count']).toBe(5)
		expect(envSummary?.attributes['namzu.config.project_file_count']).toBe(3)
		expect(envSummary?.attributes['namzu.config.env_count']).toBe(2)
		expect(envSummary?.attributes['namzu.config.default_count']).toBe(0)
		expect(envSummary?.attributes['namzu.config.user_file_count']).toBe(0)
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
