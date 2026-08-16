import { asMessageId, asRunId } from '@namzu/sdk'
import type { RunEvent } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import {
	CONTENT_BEARING_EVENT_TYPES,
	type SessionExportConfig,
	type SessionExportRecord,
	type SessionExportRedactor,
	type SessionExportSink,
	createSessionExportListener,
	describeSessionExport,
	secretRedactor,
} from '../session-export.js'

/**
 * The three properties that make exporting a session's content offerable at
 * all: a redactor can refuse, a refusal never falls open, and export cannot
 * stall the run it is exporting.
 *
 * Each of those is a sentence somebody could write in a comment. They are
 * here instead because the failure mode of every one of them is silent — a
 * record that leaves un-redacted looks exactly like a record that was
 * cleared, and a run stalled by a slow collector looks like a slow model.
 */

// Through the checked constructors: the id types are nominal, and a
// fixture that asserted its way past that would be testing a value the
// kernel cannot produce.
const RID = asRunId('run_export')
const MID = asMessageId('msg_1')

function textDelta(text: string): RunEvent {
	return { type: 'text_delta', runId: RID, iteration: 0, messageId: MID, text }
}

function collecting(): SessionExportSink & { readonly records: SessionExportRecord[] } {
	const records: SessionExportRecord[] = []
	return {
		records,
		emit: (r) => {
			records.push(r)
		},
		shutdown: async () => {},
	}
}

const AT = () => 1_700_000_000_000

function configFor(over: Partial<SessionExportConfig> = {}): SessionExportConfig {
	return {
		sink: collecting(),
		destination: 'https://collector.example/api/v1/sessions',
		now: AT,
		...over,
	}
}

describe('the redaction chain', () => {
	it('drops the record when a redactor returns null, and stops the chain there', () => {
		const sink = collecting()
		const second = vi.fn<SessionExportRedactor>((r) => r)
		const listener = createSessionExportListener(
			configFor({ sink, redactors: [(r) => (r.event.type === 'text_delta' ? null : r), second] }),
		)

		listener(textDelta('secret words'))

		expect(sink.records).toHaveLength(0)
		// The second half of the property, and the reason it is asserted: a
		// chain that kept walking would hand a dropped record to a redactor
		// that might write it somewhere itself.
		expect(second).not.toHaveBeenCalled()
		expect(listener.dropped).toBe(1)
		expect(listener.exported).toBe(0)
	})

	it('applies redactors in declared order', () => {
		const sink = collecting()
		const mark =
			(m: string): SessionExportRedactor =>
			(r) => ({
				...r,
				event: { ...r.event, text: `${(r.event as { text: string }).text}${m}` } as RunEvent,
			})
		const listener = createSessionExportListener(
			configFor({ sink, redactors: [mark('-first'), mark('-second')] }),
		)

		listener(textDelta('body'))

		// Registration order, not reverse, not deduped, not parallel — each of
		// which would produce a different string here.
		expect((sink.records[0]?.event as { text: string }).text).toBe('body-first-second')
	})

	it('drops the record when a redactor throws, and never emits the un-redacted one', () => {
		const sink = collecting()
		const listener = createSessionExportListener(
			configFor({
				sink,
				redactors: [
					() => {
						throw new Error('redactor blew up')
					},
				],
			}),
		)

		// Does not escape into the run: this listener is called from the run's
		// own event loop.
		expect(() => listener(textDelta('sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa'))).not.toThrow()

		// The whole point of the finding. A redaction stage that fails OPEN
		// exports exactly the record somebody installed a redactor to stop.
		expect(sink.records).toHaveLength(0)
		expect(listener.dropped).toBe(1)
		expect(listener.exported).toBe(0)
	})

	it('counts a throwing SINK apart from a refusing redactor', () => {
		const listener = createSessionExportListener(
			configFor({
				sink: {
					emit: () => {
						throw new Error('collector unreachable')
					},
					shutdown: async () => {},
				},
			}),
		)

		expect(() => listener(textDelta('body'))).not.toThrow()
		// The record cleared the chain and was released; whether it ARRIVED is
		// the sink's business. Conflating the two would let a broken
		// destination read as a working redactor.
		expect(listener.failed).toBe(1)
		expect(listener.dropped).toBe(0)
	})
})

describe('export cannot stall the run', () => {
	it('returns immediately from a sink whose emit takes 200ms', async () => {
		let released!: () => void
		const slow: SessionExportSink = {
			emit: () => {
				// A sink that batches, retries or dials a network. The listener
				// must not be waiting on any of it.
				void new Promise<void>((resolve) => {
					released = resolve
					setTimeout(resolve, 200)
				})
			},
			shutdown: async () => {},
		}
		const listener = createSessionExportListener(configFor({ sink: slow }))

		const started = performance.now()
		listener(textDelta('body'))
		const elapsed = performance.now() - started

		expect(elapsed).toBeLessThan(20)
		released?.()
	})
})

describe('the sink owns its own drain', () => {
	it('shutdown() resolves only after every buffered record reached the destination', async () => {
		const arrived: SessionExportRecord[] = []
		let buffer: SessionExportRecord[] = []
		const batching: SessionExportSink = {
			emit: (r) => {
				buffer.push(r)
			},
			shutdown: async () => {
				// A real batcher's flush: asynchronous, and the records are only
				// at the destination once it has run.
				await Promise.resolve()
				arrived.push(...buffer)
				buffer = []
			},
		}
		const listener = createSessionExportListener(configFor({ sink: batching }))

		for (let i = 0; i < 100; i++) listener(textDelta(`chunk ${i}`))
		expect(arrived).toHaveLength(0)

		await batching.shutdown()

		// Fails if a flush discards what it buffered, which is the shape of
		// every "we lost the last N records" export bug.
		expect(arrived).toHaveLength(100)
		expect(listener.exported).toBe(100)
	})
})

describe('the shipped secret redactor', () => {
	const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA'

	it('redacts a credential-shaped value in a tool result', () => {
		const sink = collecting()
		const listener = createSessionExportListener(configFor({ sink, redactors: [secretRedactor()] }))

		listener({
			type: 'tool_completed',
			runId: RID,
			iteration: 0,
			toolName: 'read_file',
			result: `the file said ${KEY}`,
		} as unknown as RunEvent)

		const emitted = JSON.stringify(sink.records[0]?.event)
		expect(emitted).not.toContain(KEY)
		expect(emitted).toContain('[REDACTED:')
	})

	it('leaves it alone when no redactor is installed', () => {
		const sink = collecting()
		const listener = createSessionExportListener(configFor({ sink, redactors: [] }))

		listener({
			type: 'tool_completed',
			runId: RID,
			iteration: 0,
			toolName: 'read_file',
			result: `the file said ${KEY}`,
		} as unknown as RunEvent)

		// The second half, and the one that carries the weight: without it the
		// first assertion could be satisfied by a record shape that never
		// carried the key at all, and the redactor would be proving nothing.
		expect(JSON.stringify(sink.records[0]?.event)).toContain(KEY)
	})

	it('refuses a record it cannot serialise rather than passing it through', () => {
		const cyclic = { type: 'text_delta', runId: RID } as unknown as RunEvent & { self?: unknown }
		cyclic.self = cyclic
		const sink = collecting()
		const listener = createSessionExportListener(configFor({ sink, redactors: [secretRedactor()] }))

		listener(cyclic)

		// Unscannable is exactly the record that must not leave: nothing
		// established that it is clear.
		expect(sink.records).toHaveLength(0)
		expect(listener.dropped).toBe(1)
	})
})

describe('the event-type filter', () => {
	it('excludes a type before any redactor runs', () => {
		const sink = collecting()
		const redactor = vi.fn<SessionExportRedactor>((r) => r)
		const listener = createSessionExportListener(
			configFor({ sink, eventTypes: ['run_completed'], redactors: [redactor] }),
		)

		listener(textDelta('body'))

		expect(sink.records).toHaveLength(0)
		expect(redactor).not.toHaveBeenCalled()
		expect(listener.filtered).toBe(1)
		// Filtered is not dropped: nothing refused this record, it was never
		// in scope. An operator reading `dropped: 0` is asking whether their
		// redactors are firing.
		expect(listener.dropped).toBe(0)
	})
})

describe('the disclosure', () => {
	it('names the destination, the event types, the redactor count and whether text is included', () => {
		const sentence = describeSessionExport(
			configFor({ eventTypes: ['text_delta', 'run_completed'], redactors: [secretRedactor()] }),
		)

		expect(sentence).toContain('https://collector.example/api/v1/sessions')
		expect(sentence).toContain('2 event types')
		expect(sentence).toContain('text_delta')
		expect(sentence).toContain('run_completed')
		expect(sentence).toContain('1 redactor')
		expect(sentence).toContain('conversation text IS included')
	})

	it('says text is NOT included when no exported type carries any', () => {
		const sentence = describeSessionExport(
			configFor({ eventTypes: ['token_usage_updated', 'iteration_completed'] }),
		)

		expect(sentence).toContain('no conversation text is included')
		expect(sentence).toContain('no redactors are installed')
	})

	it('reads differently when export is off', () => {
		const off = describeSessionExport()
		const on = describeSessionExport(configFor())

		expect(off).toContain('Session export is off')
		// A disclosure that read the same in both states would satisfy any test
		// asserting "the disclosure is shown" while telling a user nothing.
		expect(off).not.toBe(on)
		expect(on).toContain('every run event')
	})

	it('derives the text claim from the event types rather than a second flag', () => {
		// The property, stated as a test: every content-bearing type on its own
		// produces the "included" sentence, and a type outside the table
		// produces the other one. A second `includeMessageText` config field
		// could disagree with `eventTypes`, and this is what would catch it.
		for (const type of CONTENT_BEARING_EVENT_TYPES) {
			expect(describeSessionExport(configFor({ eventTypes: [type] }))).toContain(
				'conversation text IS included',
			)
		}
		expect(describeSessionExport(configFor({ eventTypes: ['token_usage_updated'] }))).toContain(
			'no conversation text is included',
		)
	})

	it('says nothing will be exported when the type list is empty', () => {
		// Distinct from both "off" and "everything": an empty array is a host
		// that configured export and then excluded every event, which is a
		// mistake worth reading as one.
		expect(describeSessionExport(configFor({ eventTypes: [] }))).toContain(
			'no event types (nothing will be exported)',
		)
	})
})
