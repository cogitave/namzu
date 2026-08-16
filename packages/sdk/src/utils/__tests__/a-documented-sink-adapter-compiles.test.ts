import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
	type CollectorPayload,
	nest,
	nestedAttributeSink,
} from '../../__fixtures__/nested-attribute-sink.js'
import { createLogger } from '../log/create-logger.js'

/**
 * The adapter `docs/sdk/observability/logging.md` shows a host writing.
 *
 * A code sample typed into a page is a claim nothing checks: it compiles
 * against the API that existed the day it was written and silently stops
 * compiling against any later one, while still reading as authoritative.
 * So the page does not contain the sample — it embeds this fixture, and
 * the last test here asserts the two are byte-identical. Renaming a field
 * on `LogRecord` now breaks a test rather than a reader.
 */

const DOC = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..',
	'..',
	'..',
	'docs',
	'sdk',
	'observability',
	'logging.md',
)
const FIXTURE = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'__fixtures__',
	'nested-attribute-sink.ts',
)

describe('the sink adapter the docs page shows', () => {
	it('receives a real record through the real pipeline', () => {
		// Not `emit` called by hand: built through `createLogger` so the
		// record is the shape production produces, resource stamp and all.
		const sent: CollectorPayload[] = []
		const log = createLogger({
			sink: nestedAttributeSink((p) => sent.push(p)),
			level: { current: 'debug' },
			resource: { 'service.name': 'namzu' },
			scope: 'docs-example',
		})

		log.info('run started', { 'namzu.run.id': 'run_1', 'namzu.tenant.id': 'tnt_1' })

		expect(sent).toHaveLength(1)
		expect(sent[0]?.message).toBe('run started')
		expect(sent[0]?.severity).toBe('info')
		expect(sent[0]?.fields).toMatchObject({
			namzu: { run: { id: 'run_1' }, tenant: { id: 'tnt_1' } },
		})
	})

	it('produces a timestamp a collector can parse', () => {
		const sent: CollectorPayload[] = []
		createLogger({
			sink: nestedAttributeSink((p) => sent.push(p)),
			level: { current: 'debug' },
			resource: { 'service.name': 'namzu' },
			scope: 'docs-example',
		}).info('x')

		expect(Number.isNaN(Date.parse(sent[0]?.timestamp ?? ''))).toBe(false)
	})

	it('refuses a key set the nested shape cannot represent, rather than dropping one', () => {
		// The cost the page names. `a.b` and `a.b.c` are both valid flat keys
		// and cannot both be nested objects. Returning a partial object here
		// would lose whichever field `Object.entries` reached second.
		expect(() => nest({ 'a.b': 1, 'a.b.c': 2 })).toThrow(/already a value/)
	})

	it('is the same bytes the docs page shows', () => {
		// `never-filter-a-verification`: compare the whole fixture, not a
		// prefix. A page that embedded the first half would pass a
		// `toContain` on any substring of it.
		const fixture = readFileSync(FIXTURE, 'utf8')
		const page = readFileSync(DOC, 'utf8')

		// The page embeds the body, without the import line and the file's
		// own explanatory header — the page IS that explanation.
		const body = fixture.slice(fixture.indexOf('export interface CollectorPayload')).trimEnd()

		expect(body.length).toBeGreaterThan(500)
		expect(page).toContain(body)
	})
})
