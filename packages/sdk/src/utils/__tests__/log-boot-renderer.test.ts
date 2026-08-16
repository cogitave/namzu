import { describe, expect, it } from 'vitest'

import { BOOT_EVENT_NAMES } from '../../constants/telemetry/index.js'
import { EVENT_NAME_ATTRIBUTE, type LogRecord, jsonLinesSink } from '../log/index.js'
import { prettySink } from '../log/sinks.js'
import { BOOT_TEMPLATES, scopeColour } from '../log/templates.js'

/**
 * "The logs tell me nothing when the project starts."
 *
 * The facts were all being emitted. What arrived was an absolute ISO
 * timestamp on every line — which nobody subtracts in their head — and
 * every attribute dumped as JSON, so the two that matter sat inside forty
 * that did not.
 *
 * The renderer is display ONLY. Nothing here may change a record, and
 * `jsonLinesSink` must produce the same bytes whether or not it is
 * installed; the machine-read path is the one thing that must not move.
 */

function record(over: Partial<LogRecord> & { timestamp: number }): LogRecord {
	return {
		severityText: 'info',
		body: 'starting',
		scope: { name: 'cli' },
		attributes: {},
		...over,
	} as LogRecord
}

function boot(timestamp: number, event: string, over: Partial<LogRecord> = {}): LogRecord {
	return record({
		timestamp,
		eventName: event,
		attributes: { [EVENT_NAME_ATTRIBUTE]: event },
		...over,
	} as Partial<LogRecord> & { timestamp: number })
}

/** A writable that captures bytes and can claim to be a TTY. */
function capture(isTTY = false) {
	const chunks: string[] = []
	const stream = {
		isTTY,
		write(chunk: string) {
			chunks.push(chunk)
			return true
		},
	} as unknown as NodeJS.WritableStream
	return {
		stream,
		lines: () => chunks.join('').split('\n').filter(Boolean),
		raw: () => chunks.join(''),
	}
}

/** The `+Nms` column of a rendered line. */
function deltaOf(line: string): string {
	return line.trim().split(/\s+/)[0] as string
}

describe('the boot narrative renders as a readout', () => {
	it('shows elapsed time since the previous record, not the absolute clock', () => {
		const out = capture()
		const sink = prettySink(out.stream)
		for (const t of [0, 12, 14, 48]) sink.emit(boot(t, BOOT_EVENT_NAMES.BOOT_START))

		expect(out.lines().map(deltaOf)).toEqual(['+0ms', '+12ms', '+2ms', '+34ms'])
	})

	it('gives two sinks in one process independent deltas', () => {
		// The state has to be per instance. Module-level, each sink's column
		// would depend on the other's traffic — and the failure only appears
		// when two are live at once, which is exactly when a host is
		// tee-ing a log to a file and a terminal.
		const a = capture()
		const b = capture()
		const sinkA = prettySink(a.stream)
		const sinkB = prettySink(b.stream)

		sinkA.emit(boot(0, BOOT_EVENT_NAMES.BOOT_START))
		sinkB.emit(boot(100, BOOT_EVENT_NAMES.BOOT_START))
		sinkA.emit(boot(10, BOOT_EVENT_NAMES.BOOT_READY))
		sinkB.emit(boot(130, BOOT_EVENT_NAMES.BOOT_READY))

		expect(a.lines().map(deltaOf)).toEqual(['+0ms', '+10ms'])
		expect(b.lines().map(deltaOf)).toEqual(['+0ms', '+30ms'])
	})

	it('writes no escape byte at all to a non-TTY stream', () => {
		// Scanned as bytes rather than matched as a pattern: colour leaking
		// into a redirected log is the failure, and any escape sequence at
		// all is that failure regardless of which one.
		const out = capture(false)
		const sink = prettySink(out.stream)
		for (const name of Object.values(BOOT_EVENT_NAMES)) sink.emit(boot(1, name))

		expect(out.raw()).not.toContain('\x1b')
	})

	it('colours the scope column on a TTY', () => {
		// The counterpart of the assertion above. Without it, a renderer that
		// never coloured anything would pass the non-TTY test perfectly.
		const out = capture(true)
		prettySink(out.stream).emit(boot(1, BOOT_EVENT_NAMES.CONFIG_RESOLVED))

		expect(out.raw()).toContain('\x1b[')
	})

	it('gives one scope one colour, from the string alone', () => {
		// Same input, same colour, in any process on any day. A hash seeded
		// from insertion order or process state passes inside one run and
		// fails the process-level check.
		expect(scopeColour('config')).toBe(scopeColour('config'))
		expect(scopeColour('sandbox')).toBe(scopeColour('sandbox'))
		// And it distinguishes: a constant would satisfy every line above.
		const distinct = new Set(
			['boot', 'config', 'sandbox', 'provider', 'telemetry', 'discovery'].map(scopeColour),
		)
		expect(distinct.size).toBeGreaterThan(1)
	})

	it('pads the column by the visible label, not the painted string', () => {
		// Escape bytes have length in a string and no width on screen. Padding
		// the painted form shortens every coloured column by exactly the
		// length of its escape sequence, and the columns stop lining up —
		// which is the whole reason the column exists.
		const plain = capture(false)
		const painted = capture(true)
		prettySink(plain.stream).emit(boot(1, BOOT_EVENT_NAMES.CONFIG_RESOLVED, { body: 'resolved' }))
		prettySink(painted.stream).emit(boot(1, BOOT_EVENT_NAMES.CONFIG_RESOLVED, { body: 'resolved' }))

		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the colour is the point of the comparison
		const stripped = painted.raw().replace(/\x1b\[[0-9;]*m/g, '')
		expect(stripped).toBe(plain.raw())
	})

	it('marks a warning and a refusal in a column, without a level label', () => {
		const out = capture()
		const sink = prettySink(out.stream)
		sink.emit(boot(0, BOOT_EVENT_NAMES.SANDBOX_RESOLVED, { body: 'on (basic)' }))
		sink.emit(
			boot(1, BOOT_EVENT_NAMES.SANDBOX_RESOLVED, {
				severityText: 'warn',
				body: 'commands are not confined',
			}),
		)
		sink.emit(
			boot(2, BOOT_EVENT_NAMES.BOOT_REFUSED, { severityText: 'error', body: 'refused: network' }),
		)
		const lines = out.lines()

		expect(lines[0]).not.toContain('[INFO]')
		expect(lines[1]).toContain('!')
		expect(lines[1]).not.toContain('[WARN]')
		expect(lines[2]).toContain('✗')
	})

	it('leaves the record itself untouched', () => {
		// Display only. A renderer that reformatted a field in place would
		// hand every downstream sink the rendered form instead of the fact.
		const original = boot(5, BOOT_EVENT_NAMES.CONFIG_RESOLVED, {
			attributes: { [EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.CONFIG_RESOLVED, 'a.b': 1 },
		})
		const before = structuredClone(original)

		prettySink(capture().stream).emit(original)

		expect(original).toEqual(before)
	})

	it('leaves the machine-read path byte-identical', () => {
		// The claim that matters most, and the one a snapshot of the pretty
		// output cannot make. Rendering must not be observable to anything
		// parsing the log.
		const records = Object.values(BOOT_EVENT_NAMES).map((n, i) => boot(i * 3, n))

		const alone = capture()
		const jsonAlone = jsonLinesSink(alone.stream)
		for (const r of records) jsonAlone.emit(r)

		const withRenderer = capture()
		const pretty = prettySink(capture().stream)
		const jsonAfter = jsonLinesSink(withRenderer.stream)
		for (const r of records) {
			pretty.emit(r)
			jsonAfter.emit(r)
		}

		expect(withRenderer.raw()).toBe(alone.raw())
	})

	it('renders an attribute carrying an ANSI payload inert, through the template path', () => {
		// The template path is the one that would otherwise bypass the
		// escaping — it builds its own string instead of falling through to
		// the default renderer that already escapes.
		const out = capture(false)
		prettySink(out.stream).emit(
			boot(1, BOOT_EVENT_NAMES.CONFIG_RESOLVED, {
				body: 'resolved',
				attributes: {
					[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.CONFIG_RESOLVED,
					'namzu.config.sources': '\x1b[2K\rnamzu: refused',
				},
			}),
		)

		expect(out.raw()).not.toContain('\x1b')
		expect(out.raw()).toContain('\\x1b')
	})

	it('has a template for every boot event', () => {
		// The map is typed `Record<BootEventName, …>`, so a missing member is
		// a compile error rather than a runtime hole. This asserts the runtime
		// side of the same claim: every name resolves to a function, which
		// catches a member added to the record with `as never` on it.
		for (const name of Object.values(BOOT_EVENT_NAMES)) {
			expect(typeof BOOT_TEMPLATES[name], name).toBe('function')
		}
	})

	it('renders the whole boot sequence as the design sample reads', async () => {
		// A snapshot, so any template drifting shows up as a reviewable diff
		// rather than as a line nobody notices changed. The sequence is the
		// one §6.3 of the logging standard specifies, including the two lines
		// that are the point of the exercise: the unconfined-sandbox warning
		// and the refusal.
		const out = capture(false)
		const sink = prettySink(out.stream)
		const seq: [number, string, Partial<LogRecord>][] = [
			[0, BOOT_EVENT_NAMES.BOOT_START, { body: 'starting' }],
			[
				12,
				BOOT_EVENT_NAMES.CONFIG_RESOLVED,
				{
					body: 'resolved',
					attributes: {
						'namzu.config.key.count': '37 keys',
						'namzu.config.sources': 'default(29) user-file(3) project-file(4) env(1)',
					},
				},
			],
			[
				14,
				BOOT_EVENT_NAMES.SANDBOX_RESOLVED,
				{
					body: 'on (linux-namespace)',
					attributes: { 'namzu.sandbox.enforces': 'filesystem,network,process' },
				},
			],
			[
				48,
				BOOT_EVENT_NAMES.PROVIDER_RESOLVED,
				{
					body: 'chain resolved',
					attributes: {
						'namzu.provider.chain': 'anthropic/claude-sonnet-4-6 → openai/gpt-5-mini',
						'namzu.provider.constructed': '2 of 3',
					},
				},
			],
			[
				48,
				BOOT_EVENT_NAMES.SANDBOX_RESOLVED,
				{
					severityText: 'warn',
					body: 'on (basic), but this platform enforces none of filesystem, network, process — commands are not confined',
				},
			],
			[55, BOOT_EVENT_NAMES.TELEMETRY_STATUS, { body: 'not registered — trace export is off' }],
			[
				59,
				BOOT_EVENT_NAMES.DISCOVERY_COMPLETED,
				{
					body: 'complete',
					attributes: {
						'namzu.discovery.plugins': 'plugins 2',
						'namzu.discovery.skills': 'skills 7',
					},
				},
			],
			[
				68,
				BOOT_EVENT_NAMES.BOOT_REFUSED,
				{
					severityText: 'error',
					body: 'refused',
					attributes: {
						'namzu.boot.refusal.reason':
							'`sandbox.requireIsolation` names `network`, which this host cannot enforce',
					},
				},
			],
		]
		for (const [t, event, over] of seq) sink.emit(boot(t, event, over))

		await expect(out.raw()).toMatchSnapshot()
	})

	it('keeps the old shape for a record from another vocabulary', () => {
		// A record with no boot event name has no template to be right about,
		// and inventing a column layout for it would drop the attributes it
		// does carry.
		const out = capture()
		prettySink(out.stream).emit(
			record({ timestamp: 1, body: 'something else', attributes: { k: 'v' } }),
		)

		expect(out.raw()).toContain('[INFO]')
		expect(out.raw()).toContain('{"k":"v"}')
	})
})
