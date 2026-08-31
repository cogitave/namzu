import { describe, expect, it, vi } from 'vitest'

import { LiveAgent } from './LiveAgent.js'
import { LiveSession } from './LiveSession.js'
import type {
	AudioFrame,
	AudioOutput,
	LiveModel,
	LiveModelTurn,
	SpeechRecognizer,
	SpeechSynthesizer,
	TurnDetector,
	VoiceActivityDetector,
} from './types.js'

function makeDeferred<T = void>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((innerResolve, innerReject) => {
		resolve = innerResolve
		reject = innerReject
	})
	return { promise, reject, resolve }
}

function frame(sequence: number, durationMs = 20): AudioFrame {
	const sampleRateHz = 16_000
	const samplesPerChannel = (sampleRateHz * durationMs) / 1_000
	return {
		channels: 1,
		data: new Uint8Array(samplesPerChannel * 2),
		format: 'pcm_s16le',
		sampleRateHz,
		samplesPerChannel,
		sequence,
		timestampMs: sequence * durationMs,
	}
}

async function* values<T>(items: readonly T[]): AsyncIterable<T> {
	for (const item of items) yield item
}

function stalledIterable<T>(wait: Promise<unknown>): AsyncIterable<T> {
	return {
		[Symbol.asyncIterator]() {
			return {
				async next(): Promise<IteratorResult<T>> {
					await wait
					return { done: true, value: undefined }
				},
			}
		},
	}
}

class EchoModel implements LiveModel {
	readonly label = 'echo'
	readonly turns: LiveModelTurn[] = []

	async *stream(turn: LiveModelTurn) {
		this.turns.push(turn)
		const input = turn.messages.at(-1)?.content ?? ''
		yield { messageId: 'message', text: `answer:${input}.`, type: 'text_delta' as const }
		yield {
			result: `answer:${input}.`,
			runId: `run-${this.turns.length}`,
			stopReason: 'end_turn' as const,
			type: 'completed' as const,
		}
	}
}

function twoUtteranceVad(waitBeforeSecond?: Promise<unknown>): VoiceActivityDetector {
	return {
		label: 'test-vad',
		async *detect(frames) {
			for await (const audio of frames) {
				if (audio.sequence === 0) {
					yield { timestampMs: 0, type: 'speech_start' as const }
				} else if (audio.sequence === 1) {
					yield { timestampMs: 40, type: 'speech_end' as const }
					if (waitBeforeSecond) await waitBeforeSecond
				} else if (audio.sequence === 2) {
					yield { timestampMs: 40, type: 'speech_start' as const }
				} else if (audio.sequence === 3) {
					yield { timestampMs: 80, type: 'speech_end' as const }
				}
			}
		},
	}
}

function twoUtteranceStt(): SpeechRecognizer {
	return {
		label: 'test-stt',
		async *transcribe(frames) {
			for await (const audio of frames) {
				if (audio.sequence === 0) {
					yield { text: 'fi', timestampMs: 10, type: 'partial_transcript' as const }
				} else if (audio.sequence === 1) {
					yield { text: 'first', timestampMs: 35, type: 'final_transcript' as const }
				} else if (audio.sequence === 3) {
					yield { text: 'second', timestampMs: 75, type: 'final_transcript' as const }
				}
			}
		},
	}
}

const completeTurns: TurnDetector = {
	label: 'complete',
	isTurnComplete: () => true,
}

describe('LiveSession', () => {
	it('drives start, text run, history, terminal event, and close through the public front door', async () => {
		const model = new EchoModel()
		const session = new LiveSession()
		const events: string[] = []
		session.onEvent((event) => events.push(event.type))
		await session.start(new LiveAgent({ instructions: 'Be concise', model }))

		const result = await session.run({ userInput: 'hello' }).wait()

		expect(result.status).toBe('completed')
		expect(result.message?.content).toBe('answer:hello.')
		expect(model.turns[0]?.instructions).toBe('Be concise')
		expect(model.turns[0]?.messages.at(-1)?.content).toBe('hello')
		expect(session.history.map((message) => [message.role, message.content])).toEqual([
			['user', 'hello'],
			['assistant', 'answer:hello.'],
		])
		expect(events.indexOf('turn_completed')).toBeGreaterThan(events.indexOf('assistant_text_delta'))
		await session.close()
		expect(session.state).toBe('closed')
	})

	it('isolates diagnostic listeners from the realtime path', async () => {
		const session = new LiveSession()
		session.onEvent(() => {
			throw new Error('observer failure')
		})
		await session.start(new LiveAgent({ instructions: 'test', model: new EchoModel() }))

		await expect(session.run({ userInput: 'still works' }).wait()).resolves.toMatchObject({
			status: 'completed',
		})
		await session.close()
	})

	it('interrupts an older model turn and never commits its partial assistant text', async () => {
		const firstStarted = makeDeferred()
		const model: LiveModel = {
			label: 'interruptible',
			async *stream(turn) {
				const input = turn.messages.at(-1)?.content
				if (input === 'first') {
					yield { messageId: 'first', text: 'partial', type: 'text_delta' }
					firstStarted.resolve()
					if (!turn.signal.aborted) {
						await new Promise<void>((resolve) =>
							turn.signal.addEventListener('abort', () => resolve(), { once: true }),
						)
					}
					yield { runId: 'cancelled', type: 'cancelled' }
					return
				}
				yield { messageId: 'second', text: 'complete', type: 'text_delta' }
				yield {
					result: 'complete',
					runId: 'second',
					stopReason: 'end_turn',
					type: 'completed',
				}
			},
		}
		const session = new LiveSession({ closeTimeoutMs: 100 })
		await session.start(new LiveAgent({ instructions: 'test', model }))
		const first = session.run({ userInput: 'first' })
		await firstStarted.promise

		const second = session.run({ userInput: 'second' })

		await expect(first.wait()).resolves.toMatchObject({ status: 'interrupted' })
		await expect(second.wait()).resolves.toMatchObject({ status: 'completed' })
		expect(session.history.map((message) => message.content)).toEqual([
			'first',
			'second',
			'complete',
		])
		await session.close()
	})

	it('keeps ingesting audio while synthesis is blocked and barge-in cancels old output', async () => {
		const firstAudioStarted = makeDeferred()
		const unblockFirstAudio = makeDeferred()
		const synthesizedText: string[] = []
		const cancellations: string[] = []
		let writes = 0
		const tts: SpeechSynthesizer = {
			label: 'test-tts',
			async *synthesize(chunks) {
				for await (const text of chunks) {
					synthesizedText.push(text)
					yield { final: true, frame: frame(writes + 10), text }
				}
			},
		}
		const output: AudioOutput = {
			cancel: async (_turnId, reason) => {
				cancellations.push(reason)
				unblockFirstAudio.resolve()
			},
			write: async () => {
				writes++
				if (writes === 1) {
					firstAudioStarted.resolve()
					await unblockFirstAudio.promise
				}
			},
		}
		let inputFramesRead = 0
		async function* microphone() {
			for (let index = 0; index < 4; index++) {
				inputFramesRead++
				yield frame(index)
			}
		}
		const session = new LiveSession({
			audioBufferMs: 100,
			audioOutput: output,
			closeTimeoutMs: 500,
			stt: twoUtteranceStt(),
			tts,
			turnDetector: completeTurns,
			vad: twoUtteranceVad(firstAudioStarted.promise),
		})
		const terminalEvents: string[] = []
		session.onEvent((event) => {
			if (event.type === 'turn_completed' || event.type === 'turn_interrupted') {
				terminalEvents.push(event.type)
			}
		})
		await session.start(new LiveAgent({ instructions: 'test', model: new EchoModel() }))

		await session.listen(microphone()).wait()

		expect(inputFramesRead).toBe(4)
		expect(cancellations).toContain('caller started speaking')
		expect(terminalEvents).toContain('turn_interrupted')
		expect(terminalEvents).toContain('turn_completed')
		expect(synthesizedText.some((text) => text.includes('answer:first'))).toBe(true)
		expect(session.history.map((message) => message.content)).toEqual([
			'first',
			'second',
			'answer:second.',
		])
		await session.close()
	})

	it('carries an incomplete semantic turn into the next utterance', async () => {
		const detector = vi
			.fn<TurnDetector['isTurnComplete']>()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true)
		const model = new EchoModel()
		const session = new LiveSession({
			stt: twoUtteranceStt(),
			turnDetector: { isTurnComplete: detector, label: 'semantic' },
			vad: twoUtteranceVad(),
		})
		await session.start(new LiveAgent({ instructions: 'test', model }))

		await session
			.listen(values([frame(0), frame(1), frame(2), frame(3)]), {
				responseMode: 'text',
			})
			.wait()

		expect(detector).toHaveBeenCalledTimes(2)
		expect(model.turns).toHaveLength(1)
		expect(model.turns[0]?.messages.at(-1)?.content).toBe('first second')
		await session.close()
	})

	it('refuses an oversized frame before either media driver can accept it', async () => {
		const session = new LiveSession({
			stt: twoUtteranceStt(),
			turnDetector: completeTurns,
			vad: twoUtteranceVad(),
		})
		await session.start(new LiveAgent({ instructions: 'test', model: new EchoModel() }))

		await expect(
			session.listen(values([frame(0, 200)]), { responseMode: 'text' }).wait(),
		).rejects.toMatchObject({ code: 'audio_frame_invalid' })
		await session.close()
	})

	it('refuses malformed driver events at the realtime boundary', async () => {
		const session = new LiveSession({
			stt: {
				label: 'quiet-stt',
				transcribe: () => values([]),
			},
			turnDetector: completeTurns,
			vad: {
				label: 'malformed-vad',
				detect: () => values([{ timestampMs: Number.NaN, type: 'speech_start' }]),
			},
		})
		await session.start(new LiveAgent({ instructions: 'test', model: new EchoModel() }))

		await expect(
			session.listen(values([frame(0)]), { responseMode: 'text' }).wait(),
		).rejects.toMatchObject({ code: 'invalid_driver_event' })
		await session.close()
	})

	it('refuses realtime buffer overflow instead of accumulating blocked audio puts', async () => {
		const never = new Promise<void>(() => undefined)
		const vad: VoiceActivityDetector = {
			label: 'stalled-vad',
			detect: () => stalledIterable(never),
		}
		const stt: SpeechRecognizer = {
			label: 'stalled-stt',
			transcribe: () => stalledIterable(never),
		}
		const session = new LiveSession({
			audioBufferMs: 20,
			closeTimeoutMs: 20,
			stt,
			turnDetector: completeTurns,
			vad,
		})
		await session.start(new LiveAgent({ instructions: 'test', model: new EchoModel() }))

		await expect(
			session.listen(values([frame(0), frame(1)]), { responseMode: 'text' }).wait(),
		).rejects.toMatchObject({ code: 'audio_buffer_overflow' })
		await session.close()
	})

	it('stops within the close deadline when media iterators ignore abort and throw from return', async () => {
		const never = new Promise<IteratorResult<AudioFrame>>(() => undefined)
		const source: AsyncIterable<AudioFrame> = {
			[Symbol.asyncIterator]() {
				return {
					next: () => never,
					return: () => {
						throw new Error('return failed')
					},
				}
			},
		}
		const stalled = new Promise<void>(() => undefined)
		const session = new LiveSession({
			closeTimeoutMs: 20,
			stt: {
				label: 'hostile-stt',
				transcribe: () => stalledIterable(stalled),
			},
			turnDetector: completeTurns,
			vad: {
				label: 'hostile-vad',
				detect: () => stalledIterable(stalled),
			},
		})
		await session.start(new LiveAgent({ instructions: 'test', model: new EchoModel() }))
		const listening = session.listen(source, { responseMode: 'text' })

		listening.stop()
		await expect(listening.wait()).resolves.toBeUndefined()
		await expect(session.close()).resolves.toBeUndefined()
	})

	it('forces an abort-ignoring model turn terminal at the session close deadline and fences late text', async () => {
		const release = makeDeferred()
		const model: LiveModel = {
			label: 'hostile-model',
			async *stream() {
				yield { messageId: 'early', text: 'early', type: 'text_delta' }
				await release.promise
				yield { messageId: 'late', text: 'late', type: 'text_delta' }
				yield { result: 'late', runId: 'late', stopReason: 'end_turn', type: 'completed' }
			},
		}
		const session = new LiveSession({ closeTimeoutMs: 20 })
		const deltas: string[] = []
		const earlyObserved = makeDeferred()
		session.onEvent((event) => {
			if (event.type === 'assistant_text_delta') {
				deltas.push(event.text)
				earlyObserved.resolve()
			}
		})
		await session.start(new LiveAgent({ instructions: 'test', model }))
		const turn = session.run({ userInput: 'hello' })
		await earlyObserved.promise

		await session.close()

		await expect(turn.wait()).resolves.toMatchObject({ status: 'interrupted' })
		release.resolve()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(deltas).toEqual(['early'])
		expect(session.history.map((message) => message.role)).toEqual(['user'])
	})

	it('forces an interrupted speech turn terminal when an output write ignores cancellation', async () => {
		const writeStarted = makeDeferred()
		const never = new Promise<void>(() => undefined)
		const session = new LiveSession({
			audioOutput: {
				cancel: () => undefined,
				write: async () => {
					writeStarted.resolve()
					await never
				},
			},
			closeTimeoutMs: 20,
			tts: {
				label: 'one-frame',
				async *synthesize(chunks) {
					for await (const text of chunks) yield { final: true, frame: frame(20), text }
				},
			},
		})
		await session.start(new LiveAgent({ instructions: 'test', model: new EchoModel() }))
		const first = session.run({ responseMode: 'speech', userInput: 'first' })
		await writeStarted.promise

		const second = session.run({ userInput: 'second' })

		await expect(first.wait()).resolves.toMatchObject({ status: 'interrupted' })
		await expect(second.wait()).resolves.toMatchObject({ status: 'completed' })
		await expect(session.close()).resolves.toBeUndefined()
	})
})
