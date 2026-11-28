import { describe, expect, it } from 'vitest'
import { RecordingNarration } from './narration.js'

/** A fake voice-activity stream: a segment is reported once enough samples came in. */
function service(options: { text?: string; failing?: boolean } = {}) {
	const transcribed: number[] = []
	let signal: AbortSignal | undefined
	const fake = {
		async openVad() {
			let fed = 0
			return {
				async feed(samples: Float32Array) {
					fed += samples.length
					// One second of speech from 0.5 s to 1.5 s, reported when it has passed.
					const done = fed >= 24_000 && fed - samples.length < 24_000
					return {
						detected: fed > 8_000 && fed < 24_000,
						segments: done ? [{ start: 8_000, length: 16_000 }] : [],
					}
				},
				async flush() {
					return { detected: false, segments: [] }
				},
				close() {},
			}
		},
		async transcribe(samples: Float32Array, abort: AbortSignal) {
			signal = abort
			transcribed.push(samples.length)
			if (options.failing) throw new Error('model gone')
			return options.text ?? ' now I filter the overdue ones '
		},
	}
	return { fake, transcribed, signal: () => signal }
}

const push = (narration: RecordingNarration, seconds: number) => {
	for (let at = 0; at < seconds * 10; at++) narration.push(new Float32Array(1_600))
}

describe('narration', () => {
	it('turns a spoken segment into one say with the moment it began, decoded locally, no language', async () => {
		const { fake, transcribed } = service()
		const said: [string, number][] = []
		const narration = new RecordingNarration({
			service: fake as never,
			say: (text, startMs) => said.push([text, startMs]),
			onDisconnect: () => said.push(['disconnected', -1]),
		})
		narration.start()
		push(narration, 3)
		await narration.stop()
		expect(said).toEqual([['now I filter the overdue ones', 600]])
		expect(transcribed).toHaveLength(1)
	})

	it('drops a line the recognizer invents on silence', async () => {
		const { fake } = service({ text: 'İzlediğiniz için teşekkürler' })
		const said: string[] = []
		const narration = new RecordingNarration({
			service: fake as never,
			say: (text) => said.push(text),
			onDisconnect: () => undefined,
		})
		narration.start()
		push(narration, 3)
		await narration.stop()
		expect(said).toEqual([])
	})

	it('tells the recording once when the models stop answering, and keeps nothing', async () => {
		const { fake } = service({ failing: true })
		const events: string[] = []
		const narration = new RecordingNarration({
			service: fake as never,
			say: (text) => events.push(text),
			onDisconnect: () => events.push('disconnected'),
		})
		narration.start()
		push(narration, 3)
		await narration.stop()
		expect(events).toEqual(['disconnected'])
		expect(narration.running).toBe(false)
	})

	it('takes no audio after it is stopped', async () => {
		const { fake } = service()
		const narration = new RecordingNarration({
			service: fake as never,
			say: () => undefined,
			onDisconnect: () => undefined,
		})
		narration.start()
		await narration.stop()
		expect(() => narration.push(new Float32Array(10))).not.toThrow()
	})
})
