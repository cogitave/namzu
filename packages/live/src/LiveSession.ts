import { randomUUID } from 'node:crypto'

import type { LiveAgent } from './LiveAgent.js'
import { LiveError } from './errors.js'
import { WeightedAsyncQueue } from './queue.js'
import type {
	AudioFrame,
	AudioOutput,
	LiveMessage,
	LiveModelEvent,
	LiveSessionEvent,
	LiveSessionState,
	LiveTurnResult,
	LiveUsage,
	SpeechRecognizer,
	SpeechSynthesizer,
	TranscriptEvent,
	TurnDetector,
	VoiceActivityDetector,
	VoiceActivityEvent,
} from './types.js'

const DEFAULT_AUDIO_BUFFER_MS = 1_000
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000
const DEFAULT_END_OF_TURN_TIMEOUT_MS = 2_000
const DEFAULT_MAX_FRAME_DURATION_MS = 100
const DEFAULT_MAX_SPEECH_DURATION_MS = 30_000
const DEFAULT_SPEECH_BUFFER_CHARS = 1_024
const DEFAULT_SPEECH_CHUNK_CHARS = 240
const DEFAULT_SPEECH_MIN_CHARS = 24

interface Deferred<T> {
	readonly promise: Promise<T>
	reject(error: unknown): void
	resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
	let reject!: (error: unknown) => void
	let resolve!: (value: T) => void
	const promise = new Promise<T>((innerResolve, innerReject) => {
		resolve = innerResolve
		reject = innerReject
	})
	return { promise, reject, resolve }
}

class ListeningStopped extends Error {
	constructor(readonly reason: string) {
		super(reason)
		this.name = 'ListeningStopped'
	}
}

class PhraseSegmenter {
	private buffer = ''

	constructor(
		private readonly minimumChars: number,
		private readonly maximumChars: number,
	) {}

	push(delta: string): string[] {
		this.buffer += delta
		const chunks: string[] = []
		for (;;) {
			const boundary = this.findBoundary()
			if (boundary === 0) return chunks
			chunks.push(this.buffer.slice(0, boundary))
			this.buffer = this.buffer.slice(boundary)
		}
	}

	finish(): string[] {
		if (this.buffer.length === 0) return []
		const chunk = this.buffer
		this.buffer = ''
		return [chunk]
	}

	private findBoundary(): number {
		if (this.buffer.length < this.minimumChars) return 0
		const searchable = this.buffer.slice(0, this.maximumChars)
		const sentence = searchable.search(/[.!?。！？](?:\s|$)/u)
		if (sentence >= 0) {
			let boundary = sentence + 1
			while (boundary < this.buffer.length && /\s/u.test(this.buffer[boundary] ?? '')) boundary++
			return boundary
		}
		if (this.buffer.length < this.maximumChars) return 0
		const whitespace = searchable.lastIndexOf(' ')
		return whitespace >= this.minimumChars ? whitespace + 1 : this.maximumChars
	}
}

interface TurnRecord {
	readonly controller: AbortController
	readonly createdAt: number
	readonly generation: number
	readonly handle: LiveTurn
	readonly responseMode: 'speech' | 'text'
	cancelOutput?: Promise<void>
	interruptTimer?: ReturnType<typeof setTimeout>
	task: Promise<void>
}

interface Utterance {
	decisionStarted: boolean
	endedAt?: number
	finalAt?: number
	finalText?: string
	readonly id: number
	readonly startedAt: number
	speechTimer?: ReturnType<typeof setTimeout>
	transcriptTimer?: ReturnType<typeof setTimeout>
}

interface ListeningRecord {
	cleanupTask?: Promise<void>
	readonly controller: AbortController
	decisionChain: Promise<void>
	readonly handle: LiveListening
	readonly iterators: Set<AsyncIterator<unknown>>
	readonly pendingTurns: Set<Promise<LiveTurnResult>>
	readonly pendingFinalTranscripts: Extract<TranscriptEvent, { type: 'final_transcript' }>[]
	pendingText: string
	readonly recognizerQueue: WeightedAsyncQueue<AudioFrame>
	readonly vadQueue: WeightedAsyncQueue<AudioFrame>
	readonly utterances: Utterance[]
	nextUtteranceId: number
	task: Promise<void>
}

export interface LiveSessionOptions {
	readonly audioBufferMs?: number
	readonly audioOutput?: AudioOutput
	readonly closeTimeoutMs?: number
	readonly endOfTurnTimeoutMs?: number
	readonly maxFrameDurationMs?: number
	readonly maxSpeechDurationMs?: number
	readonly speechBufferChars?: number
	readonly speechChunkChars?: number
	readonly speechMinimumChars?: number
	readonly stt?: SpeechRecognizer
	readonly tts?: SpeechSynthesizer
	readonly turnDetector?: TurnDetector
	readonly vad?: VoiceActivityDetector
}

export interface LiveRunOptions {
	readonly interrupt?: boolean
	readonly responseMode?: 'speech' | 'text'
	readonly userInput: string
}

export interface LiveListenOptions {
	readonly responseMode?: 'speech' | 'text'
}

export type LiveEventListener = (event: LiveSessionEvent) => void

interface TurnControl {
	readonly completion: Deferred<LiveTurnResult>
	settled: boolean
}

const turnControls = new WeakMap<LiveTurn, TurnControl>()

function finishTurn(turn: LiveTurn, result: LiveTurnResult): boolean {
	const control = turnControls.get(turn)
	if (!control || control.settled) return false
	control.settled = true
	control.completion.resolve(result)
	return true
}

function failTurn(turn: LiveTurn, error: unknown): boolean {
	const control = turnControls.get(turn)
	if (!control || control.settled) return false
	control.settled = true
	control.completion.reject(error)
	return true
}

function isTurnSettled(turn: LiveTurn): boolean {
	return turnControls.get(turn)?.settled ?? true
}

export class LiveTurn {
	readonly id: string
	private readonly interruptTurn: (reason: string) => void

	constructor(id: string, interruptTurn: (reason: string) => void) {
		this.id = id
		this.interruptTurn = interruptTurn
		turnControls.set(this, { completion: deferred<LiveTurnResult>(), settled: false })
	}

	interrupt(reason = 'caller interrupted the turn'): void {
		this.interruptTurn(reason)
	}

	wait(): Promise<LiveTurnResult> {
		const control = turnControls.get(this)
		if (!control) return Promise.reject(new Error('Invalid live turn handle.'))
		return control.completion.promise
	}
}

interface ListeningControl {
	readonly completion: Deferred<void>
	settled: boolean
}

const listeningControls = new WeakMap<LiveListening, ListeningControl>()

function finishListening(listening: LiveListening): void {
	const control = listeningControls.get(listening)
	if (!control || control.settled) return
	control.settled = true
	control.completion.resolve()
}

function failListening(listening: LiveListening, error: unknown): void {
	const control = listeningControls.get(listening)
	if (!control || control.settled) return
	control.settled = true
	control.completion.reject(error)
}

function isListeningSettled(listening: LiveListening): boolean {
	return listeningControls.get(listening)?.settled ?? true
}

export class LiveListening {
	private readonly stopListening: (reason: string) => void

	constructor(stopListening: (reason: string) => void) {
		this.stopListening = stopListening
		listeningControls.set(this, { completion: deferred<void>(), settled: false })
	}

	stop(reason = 'caller stopped listening'): void {
		this.stopListening(reason)
	}

	wait(): Promise<void> {
		const control = listeningControls.get(this)
		if (!control) return Promise.reject(new Error('Invalid live listening handle.'))
		return control.completion.promise
	}
}

export class LiveSession {
	private readonly activeTurns = new Set<TurnRecord>()
	private agent?: LiveAgent
	private readonly listeners = new Set<LiveEventListener>()
	private readonly messages: LiveMessage[] = []
	private currentTurn?: TurnRecord
	private listening?: ListeningRecord
	private stateValue: LiveSessionState = 'idle'
	private turnGeneration = 0
	private readonly options: Required<
		Pick<
			LiveSessionOptions,
			| 'audioBufferMs'
			| 'closeTimeoutMs'
			| 'endOfTurnTimeoutMs'
			| 'maxFrameDurationMs'
			| 'maxSpeechDurationMs'
			| 'speechBufferChars'
			| 'speechChunkChars'
			| 'speechMinimumChars'
		>
	> &
		Omit<
			LiveSessionOptions,
			| 'audioBufferMs'
			| 'closeTimeoutMs'
			| 'endOfTurnTimeoutMs'
			| 'maxFrameDurationMs'
			| 'maxSpeechDurationMs'
			| 'speechBufferChars'
			| 'speechChunkChars'
			| 'speechMinimumChars'
		>

	constructor(options: LiveSessionOptions = {}) {
		this.options = {
			...options,
			audioBufferMs: options.audioBufferMs ?? DEFAULT_AUDIO_BUFFER_MS,
			closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
			endOfTurnTimeoutMs: options.endOfTurnTimeoutMs ?? DEFAULT_END_OF_TURN_TIMEOUT_MS,
			maxFrameDurationMs: options.maxFrameDurationMs ?? DEFAULT_MAX_FRAME_DURATION_MS,
			maxSpeechDurationMs: options.maxSpeechDurationMs ?? DEFAULT_MAX_SPEECH_DURATION_MS,
			speechBufferChars: options.speechBufferChars ?? DEFAULT_SPEECH_BUFFER_CHARS,
			speechChunkChars: options.speechChunkChars ?? DEFAULT_SPEECH_CHUNK_CHARS,
			speechMinimumChars: options.speechMinimumChars ?? DEFAULT_SPEECH_MIN_CHARS,
		}
		this.validateOptions()
	}

	get history(): readonly LiveMessage[] {
		return [...this.messages]
	}

	get state(): LiveSessionState {
		return this.stateValue
	}

	onEvent(listener: LiveEventListener): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	async start(agent: LiveAgent): Promise<void> {
		if (this.stateValue === 'closed') {
			throw new LiveError('session_closed', 'A closed live session cannot be started again.')
		}
		if (this.agent) {
			throw new LiveError('session_already_started', 'This live session has already been started.')
		}
		this.agent = agent
		this.setState('ready')
	}

	run(options: LiveRunOptions): LiveTurn {
		const agent = this.requireAgent()
		if (options.userInput.trim().length === 0) {
			throw new LiveError('invalid_user_input', 'A live turn requires non-empty user input.')
		}
		const responseMode = options.responseMode ?? 'text'
		this.validateResponseMode(responseMode)
		if (this.currentTurn && !isTurnSettled(this.currentTurn.handle)) {
			if (options.interrupt === false) {
				throw new LiveError('turn_in_progress', 'A live turn is already running.')
			}
			this.interruptRecord(this.currentTurn, 'superseded by a newer turn')
		}

		const predecessor = this.currentTurn?.task
		const userMessage: LiveMessage = {
			content: options.userInput,
			createdAt: Date.now(),
			id: randomUUID(),
			role: 'user',
		}
		this.messages.push(userMessage)
		const messages = [...this.messages]
		const controller = new AbortController()
		const generation = ++this.turnGeneration
		const turnId = randomUUID()
		const handle = new LiveTurn(turnId, (reason) => {
			const active = this.currentTurn
			if (active?.handle.id === turnId) this.interruptRecord(active, reason)
		})
		const record: TurnRecord = {
			controller,
			createdAt: performance.now(),
			generation,
			handle,
			responseMode,
			task: Promise.resolve(),
		}
		this.activeTurns.add(record)
		this.currentTurn = record
		this.emit({ turnId, type: 'turn_started', userText: options.userInput })
		record.task = this.executeTurn(record, agent, messages, predecessor)
		return handle
	}

	listen(frames: AsyncIterable<AudioFrame>, options: LiveListenOptions = {}): LiveListening {
		this.requireAgent()
		if (this.listening) {
			throw new LiveError(
				'already_listening',
				'This live session already has an audio ingress pump.',
			)
		}
		if (!this.options.vad) {
			throw new LiveError(
				'missing_voice_activity_detector',
				'Audio listening requires a VAD driver.',
			)
		}
		if (!this.options.stt) {
			throw new LiveError(
				'missing_speech_recognizer',
				'Audio listening requires a speech recognizer.',
			)
		}
		if (!this.options.turnDetector) {
			throw new LiveError('missing_turn_detector', 'Audio listening requires a turn detector.')
		}
		const responseMode = options.responseMode ?? 'speech'
		this.validateResponseMode(responseMode)

		const controller = new AbortController()
		const handle = new LiveListening((reason) => {
			const active = this.listening
			if (active?.handle === handle) this.stopListening(active, reason)
		})
		const record: ListeningRecord = {
			controller,
			decisionChain: Promise.resolve(),
			handle,
			iterators: new Set(),
			nextUtteranceId: 1,
			pendingText: '',
			pendingFinalTranscripts: [],
			pendingTurns: new Set(),
			recognizerQueue: new WeightedAsyncQueue(this.options.audioBufferMs),
			task: Promise.resolve(),
			utterances: [],
			vadQueue: new WeightedAsyncQueue(this.options.audioBufferMs),
		}
		this.listening = record
		this.setState('listening')
		record.task = this.executeListening(record, frames, responseMode)
		void record.task.then(
			() => finishListening(handle),
			(error) => failListening(handle, error),
		)
		return handle
	}

	async close(): Promise<void> {
		if (this.stateValue === 'closed') return
		const listening = this.listening
		if (listening) this.stopListening(listening, 'session closed')
		const turns = [...this.activeTurns]
		for (const turn of turns) {
			if (!isTurnSettled(turn.handle)) this.interruptRecord(turn, 'session closed')
		}
		this.turnGeneration++

		const tasks = [listening?.task, ...turns.map((turn) => turn.task)].filter(
			(task): task is Promise<void> => Boolean(task),
		)
		await this.settleWithin(Promise.allSettled(tasks), this.options.closeTimeoutMs)
		if (listening && !isListeningSettled(listening.handle)) finishListening(listening.handle)
		for (const turn of turns) {
			if (!isTurnSettled(turn.handle)) {
				this.forceInterrupted(turn, 'session close deadline elapsed')
			}
		}
		this.setState('closed')
	}

	private async executeTurn(
		record: TurnRecord,
		agent: LiveAgent,
		messages: readonly LiveMessage[],
		predecessor?: Promise<void>,
	): Promise<void> {
		const startedAt = record.createdAt
		let runId: string | undefined
		let usage: LiveUsage | undefined
		let text = ''
		let speechQueue: WeightedAsyncQueue<string> | undefined
		let synthesisTask: Promise<void> | undefined
		try {
			if (predecessor) await this.settleWithin(predecessor, this.options.closeTimeoutMs)
			if (record.controller.signal.aborted) {
				await this.finishInterrupted(record, startedAt)
				return
			}
			if (this.isCurrent(record)) this.setState('thinking')

			speechQueue =
				record.responseMode === 'speech'
					? new WeightedAsyncQueue<string>(this.options.speechBufferChars)
					: undefined
			synthesisTask = speechQueue ? this.synthesize(record, speechQueue) : undefined
			if (synthesisTask) void synthesisTask.catch(() => undefined)
			const segmenter = new PhraseSegmenter(
				this.options.speechMinimumChars,
				this.options.speechChunkChars,
			)
			let terminal: Extract<LiveModelEvent, { type: 'cancelled' | 'completed' }> | undefined
			const stream = agent.model.stream({
				instructions: agent.instructions,
				messages,
				signal: record.controller.signal,
			})

			try {
				for await (const event of stream) {
					if (terminal) {
						throw new LiveError(
							'model_protocol_error',
							'The model emitted an event after its terminal event.',
						)
					}
					if (event.type === 'text_delta') {
						if (record.controller.signal.aborted || !this.isCurrent(record)) continue
						text += event.text
						this.emit({ text: event.text, turnId: record.handle.id, type: 'assistant_text_delta' })
						if (record.responseMode === 'text') this.setState('responding')
						if (speechQueue) {
							for (const chunk of segmenter.push(event.text)) {
								await speechQueue.push(chunk, chunk.length, record.controller.signal)
							}
						}
						continue
					}
					if (event.type === 'usage') {
						runId = event.runId
						usage = event.usage
						this.emit({
							runId: event.runId,
							turnId: record.handle.id,
							type: 'usage',
							usage: event.usage,
						})
						continue
					}
					terminal = event
					runId = event.runId
				}
			} finally {
				if (speechQueue) {
					if (!record.controller.signal.aborted) {
						for (const chunk of segmenter.finish()) {
							await speechQueue.push(chunk, chunk.length, record.controller.signal)
						}
					}
					speechQueue.close()
				}
			}

			if (synthesisTask) await synthesisTask
			if (record.cancelOutput) await record.cancelOutput
			if (record.controller.signal.aborted || terminal?.type === 'cancelled') {
				await this.finishInterrupted(record, startedAt)
				return
			}
			if (terminal?.type !== 'completed') {
				throw new LiveError(
					'model_protocol_error',
					'The model stream ended without a terminal event.',
				)
			}
			if (text.length === 0) {
				throw new LiveError(
					'model_protocol_error',
					'The model completed without a speakable text result.',
				)
			}
			const message: LiveMessage = {
				content: text,
				createdAt: Date.now(),
				id: randomUUID(),
				role: 'assistant',
			}
			this.messages.push(message)
			const latencyMs = performance.now() - startedAt
			if (
				finishTurn(record.handle, {
					latencyMs,
					message,
					runId,
					status: 'completed',
					turnId: record.handle.id,
					...(usage ? { usage } : {}),
				})
			) {
				this.emit({
					latencyMs,
					message,
					runId: runId ?? terminal.runId,
					turnId: record.handle.id,
					type: 'turn_completed',
				})
			}
		} catch (error) {
			speechQueue?.close(error)
			if (synthesisTask) {
				await this.settleWithin(synthesisTask, this.options.closeTimeoutMs)
			}
			if (record.controller.signal.aborted) {
				const reason = record.controller.signal.reason
				if (
					reason instanceof ListeningStopped ||
					(reason instanceof LiveError && reason.code === 'turn_interrupted')
				) {
					await this.finishInterrupted(record, startedAt)
					return
				}
			}
			const failure = error instanceof Error ? error : new Error(String(error))
			if (failTurn(record.handle, failure)) {
				this.emit({ error: failure, turnId: record.handle.id, type: 'turn_failed' })
			}
		} finally {
			if (record.interruptTimer) clearTimeout(record.interruptTimer)
			this.activeTurns.delete(record)
			if (this.currentTurn === record) {
				this.currentTurn = undefined
				if (this.stateValue !== 'closed') this.setState(this.listening ? 'listening' : 'ready')
			}
		}
	}

	private async synthesize(record: TurnRecord, chunks: WeightedAsyncQueue<string>): Promise<void> {
		const tts = this.options.tts
		const output = this.options.audioOutput
		if (!tts || !output) return
		const context = { signal: record.controller.signal, turnId: record.handle.id }
		try {
			for await (const audio of tts.synthesize(chunks, context)) {
				this.validateAudioFrame(audio.frame)
				if (record.controller.signal.aborted || !this.isCurrent(record)) continue
				this.setState('speaking')
				await output.write(audio, context)
				if (record.controller.signal.aborted || !this.isCurrent(record)) continue
				this.emit({ audio, turnId: record.handle.id, type: 'assistant_audio' })
			}
		} catch (error) {
			chunks.close(error)
			if (!record.controller.signal.aborted) record.controller.abort(error)
			throw error
		}
	}

	private async executeListening(
		record: ListeningRecord,
		frames: AsyncIterable<AudioFrame>,
		responseMode: 'speech' | 'text',
	): Promise<void> {
		const vad = this.options.vad
		const stt = this.options.stt
		if (!vad || !stt) return
		const sourceIterator = frames[Symbol.asyncIterator]()
		record.iterators.add(sourceIterator)
		const vadIterator = vad
			.detect(record.vadQueue, { signal: record.controller.signal })
			[Symbol.asyncIterator]()
		const sttIterator = stt
			.transcribe(record.recognizerQueue, {
				signal: record.controller.signal,
			})
			[Symbol.asyncIterator]()
		record.iterators.add(vadIterator)
		record.iterators.add(sttIterator)

		const guard = async (task: Promise<void>): Promise<void> => {
			try {
				await task
			} catch (error) {
				if (!record.controller.signal.aborted) record.controller.abort(error)
				throw error
			}
		}
		const pumpTask = guard(this.pumpAudio(record, sourceIterator))
		const vadTask = guard(this.consumeVad(record, vadIterator, responseMode))
		const sttTask = guard(this.consumeTranscripts(record, sttIterator, responseMode))
		const tasks = [pumpTask, vadTask, sttTask]
		const settled = Promise.allSettled(tasks)
		const aborted = new Promise<'aborted'>((resolve) => {
			if (record.controller.signal.aborted) resolve('aborted')
			else
				record.controller.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
		})

		try {
			const pumpResult = await Promise.race([
				pumpTask.then(
					() => 'done' as const,
					() => 'failed' as const,
				),
				aborted,
			])
			if (pumpResult === 'aborted') {
				await this.cleanupListening(record)
				await this.settleWithin(settled, this.options.closeTimeoutMs)
				const reason = record.controller.signal.reason
				if (reason instanceof ListeningStopped) return
				throw reason
			}
			if (pumpResult === 'done') {
				const driversClosed = await this.settleWithin(
					Promise.allSettled([vadTask, sttTask]),
					this.options.closeTimeoutMs,
				)
				if (!driversClosed) {
					record.controller.abort(
						new LiveError(
							'driver_close_timeout',
							'Media drivers did not flush after audio input ended.',
						),
					)
				}
			}

			await Promise.race([settled, aborted])
			if (record.controller.signal.aborted) {
				await this.cleanupListening(record)
				const reason = record.controller.signal.reason
				if (reason instanceof ListeningStopped) return
				throw reason
			}

			const results = await settled
			const rejected = results.find(
				(result): result is PromiseRejectedResult => result.status === 'rejected',
			)
			if (rejected) throw rejected.reason
			const decisionsDone = await this.settleWithin(
				record.decisionChain,
				this.options.closeTimeoutMs,
			)
			if (!decisionsDone) {
				throw new LiveError(
					'driver_close_timeout',
					'Turn detection did not settle after input ended.',
				)
			}
			if (
				record.utterances.some((utterance) => !utterance.decisionStarted) ||
				record.pendingFinalTranscripts.length > 0 ||
				record.pendingText
			) {
				throw new LiveError(
					'incomplete_utterance',
					'Audio input ended before the current transcript became a complete turn.',
				)
			}
			await Promise.all(record.pendingTurns)
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error))
			if (!(failure instanceof ListeningStopped)) {
				this.emit({ error: failure, type: 'listener_failed' })
				throw failure
			}
		} finally {
			await this.cleanupListening(record)
			for (const utterance of record.utterances) this.clearUtteranceTimers(utterance)
			if (this.listening === record) {
				this.listening = undefined
				if (this.stateValue !== 'closed' && !this.currentTurn) this.setState('ready')
			}
		}
	}

	private async pumpAudio(
		record: ListeningRecord,
		iterator: AsyncIterator<AudioFrame>,
	): Promise<void> {
		try {
			while (!record.controller.signal.aborted) {
				const next = await iterator.next()
				if (next.done) break
				const durationMs = this.validateAudioFrame(next.value)
				if (!record.vadQueue.canPush(durationMs) || !record.recognizerQueue.canPush(durationMs)) {
					throw new LiveError(
						'audio_buffer_overflow',
						`Audio ingress exceeded the ${this.options.audioBufferMs}ms realtime buffer.`,
					)
				}
				record.vadQueue.tryPush(next.value, durationMs)
				record.recognizerQueue.tryPush(next.value, durationMs)
			}
		} finally {
			record.vadQueue.close()
			record.recognizerQueue.close()
		}
	}

	private async consumeVad(
		record: ListeningRecord,
		iterator: AsyncIterator<VoiceActivityEvent>,
		responseMode: 'speech' | 'text',
	): Promise<void> {
		while (!record.controller.signal.aborted) {
			const next = await iterator.next()
			if (next.done) return
			const event = next.value
			this.validateVoiceActivityEvent(event)
			this.emit({ event, type: 'voice_activity' })
			if (event.type === 'speech_start') {
				const active = record.utterances.find((utterance) => utterance.endedAt === undefined)
				if (active) {
					throw new LiveError('invalid_driver_event', 'VAD emitted speech_start before speech_end.')
				}
				const utterance: Utterance = {
					decisionStarted: false,
					id: record.nextUtteranceId++,
					startedAt: event.timestampMs,
				}
				utterance.speechTimer = setTimeout(() => {
					if (!record.controller.signal.aborted) {
						record.controller.abort(
							new LiveError(
								'speech_too_long',
								`Speech exceeded ${this.options.maxSpeechDurationMs}ms without an endpoint.`,
							),
						)
					}
				}, this.options.maxSpeechDurationMs)
				record.utterances.push(utterance)
				const pendingFinal = record.pendingFinalTranscripts.shift()
				if (pendingFinal) {
					utterance.finalText = pendingFinal.text
					utterance.finalAt = pendingFinal.timestampMs
				}
				if (this.currentTurn && !isTurnSettled(this.currentTurn.handle)) {
					this.interruptRecord(this.currentTurn, 'caller started speaking')
				}
				continue
			}

			const utterance = [...record.utterances]
				.reverse()
				.find((candidate) => candidate.endedAt === undefined)
			if (!utterance) {
				throw new LiveError('invalid_driver_event', 'VAD emitted speech_end without speech_start.')
			}
			if (event.timestampMs < utterance.startedAt) {
				throw new LiveError(
					'invalid_driver_event',
					'VAD emitted speech_end before the matching speech_start.',
				)
			}
			utterance.endedAt = event.timestampMs
			if (utterance.speechTimer) clearTimeout(utterance.speechTimer)
			if (!utterance.finalText) {
				utterance.transcriptTimer = setTimeout(() => {
					if (!record.controller.signal.aborted && !utterance.finalText) {
						record.controller.abort(
							new LiveError(
								'transcript_timeout',
								`Speech recognition did not finalize within ${this.options.endOfTurnTimeoutMs}ms.`,
							),
						)
					}
				}, this.options.endOfTurnTimeoutMs)
			}
			this.scheduleDecision(record, utterance, responseMode)
		}
	}

	private async consumeTranscripts(
		record: ListeningRecord,
		iterator: AsyncIterator<TranscriptEvent>,
		responseMode: 'speech' | 'text',
	): Promise<void> {
		while (!record.controller.signal.aborted) {
			const next = await iterator.next()
			if (next.done) return
			const event = next.value
			this.validateTranscriptEvent(event)
			this.emit({ event, type: 'transcript' })
			if (event.type !== 'final_transcript') continue
			if (event.text.trim().length === 0) {
				throw new LiveError('invalid_driver_event', 'Speech recognition finalized empty text.')
			}
			const utterance = record.utterances.find((candidate) => candidate.finalText === undefined)
			if (!utterance) {
				record.pendingFinalTranscripts.push(event)
				continue
			}
			utterance.finalText = event.text
			utterance.finalAt = event.timestampMs
			if (utterance.transcriptTimer) clearTimeout(utterance.transcriptTimer)
			this.scheduleDecision(record, utterance, responseMode)
		}
	}

	private scheduleDecision(
		record: ListeningRecord,
		utterance: Utterance,
		responseMode: 'speech' | 'text',
	): void {
		if (
			utterance.decisionStarted ||
			utterance.endedAt === undefined ||
			utterance.finalAt === undefined ||
			utterance.finalText === undefined
		) {
			return
		}
		utterance.decisionStarted = true
		record.decisionChain = record.decisionChain.then(async () => {
			try {
				if (record.controller.signal.aborted) return
				const transcript = [record.pendingText, utterance.finalText].filter(Boolean).join(' ')
				const complete = await this.options.turnDetector?.isTurnComplete({
					history: this.history,
					signal: record.controller.signal,
					speechEndedAt: utterance.endedAt as number,
					speechStartedAt: utterance.startedAt,
					transcript,
					transcriptFinalAt: utterance.finalAt as number,
				})
				if (!complete) {
					record.pendingText = transcript
					return
				}
				record.pendingText = ''
				const turn = this.run({ responseMode, userInput: transcript })
				const pending = turn.wait()
				record.pendingTurns.add(pending)
				void pending.then(
					() => record.pendingTurns.delete(pending),
					(error) => {
						record.pendingTurns.delete(pending)
						if (!record.controller.signal.aborted) record.controller.abort(error)
					},
				)
			} finally {
				this.clearUtteranceTimers(utterance)
				const index = record.utterances.indexOf(utterance)
				if (index >= 0) record.utterances.splice(index, 1)
			}
		})
		record.decisionChain.catch((error) => {
			if (!record.controller.signal.aborted) record.controller.abort(error)
		})
	}

	private interruptRecord(record: TurnRecord, reason: string): void {
		if (isTurnSettled(record.handle) || record.controller.signal.aborted) return
		record.controller.abort(new LiveError('turn_interrupted', reason))
		if (record.responseMode === 'speech' && this.options.audioOutput) {
			try {
				record.cancelOutput = Promise.resolve(
					this.options.audioOutput.cancel(record.handle.id, reason),
				)
			} catch (error) {
				record.cancelOutput = Promise.reject(error)
			}
			void record.cancelOutput.catch(() => undefined)
		}
		record.interruptTimer = setTimeout(() => {
			this.forceInterrupted(record, `${reason}; cleanup deadline elapsed`)
		}, this.options.closeTimeoutMs)
	}

	private stopListening(record: ListeningRecord, reason: string): void {
		if (record.controller.signal.aborted) return
		record.controller.abort(new ListeningStopped(reason))
		record.vadQueue.close()
		record.recognizerQueue.close()
		void this.cleanupListening(record)
	}

	private async finishInterrupted(record: TurnRecord, startedAt: number): Promise<void> {
		try {
			if (record.cancelOutput) await record.cancelOutput
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error))
			if (failTurn(record.handle, failure)) {
				this.emit({ error: failure, turnId: record.handle.id, type: 'turn_failed' })
			}
			return
		}
		const reason =
			record.controller.signal.reason instanceof Error
				? record.controller.signal.reason.message
				: 'turn interrupted'
		const latencyMs = performance.now() - startedAt
		if (finishTurn(record.handle, { latencyMs, status: 'interrupted', turnId: record.handle.id })) {
			this.emit({ reason, turnId: record.handle.id, type: 'turn_interrupted' })
		}
	}

	private forceInterrupted(record: TurnRecord, reason: string): void {
		if (
			finishTurn(record.handle, {
				latencyMs: performance.now() - record.createdAt,
				status: 'interrupted',
				turnId: record.handle.id,
			})
		) {
			this.emit({ reason, turnId: record.handle.id, type: 'turn_interrupted' })
		}
	}

	private async cleanupListening(record: ListeningRecord): Promise<void> {
		if (record.cleanupTask) return record.cleanupTask
		record.vadQueue.close()
		record.recognizerQueue.close()
		record.cleanupTask = (async () => {
			await this.settleWithin(
				this.requestIteratorCleanup(record.iterators),
				this.options.closeTimeoutMs,
			)
		})()
		return record.cleanupTask
	}

	private async requestIteratorCleanup(iterators: Set<AsyncIterator<unknown>>): Promise<void> {
		await Promise.allSettled(
			[...iterators].map(async (iterator) => {
				if (iterator.return) await iterator.return()
			}),
		)
		iterators.clear()
	}

	private clearUtteranceTimers(utterance: Utterance): void {
		if (utterance.speechTimer) clearTimeout(utterance.speechTimer)
		if (utterance.transcriptTimer) clearTimeout(utterance.transcriptTimer)
	}

	private validateResponseMode(responseMode: 'speech' | 'text'): void {
		if (responseMode !== 'speech') return
		if (!this.options.tts) {
			throw new LiveError('missing_speech_synthesizer', 'Speech responses require a synthesizer.')
		}
		if (!this.options.audioOutput) {
			throw new LiveError(
				'missing_audio_output',
				'Speech responses require a cancellable audio output.',
			)
		}
	}

	private validateAudioFrame(frame: AudioFrame): number {
		if (!(frame.data instanceof Uint8Array)) {
			throw new LiveError('audio_frame_invalid', 'Audio data must be a Uint8Array.')
		}
		if (
			!Number.isInteger(frame.sampleRateHz) ||
			frame.sampleRateHz < 8_000 ||
			frame.sampleRateHz > 192_000
		) {
			throw new LiveError(
				'audio_frame_invalid',
				'Audio sampleRateHz must be an integer from 8000 to 192000.',
			)
		}
		if (!Number.isInteger(frame.channels) || frame.channels < 1 || frame.channels > 8) {
			throw new LiveError('audio_frame_invalid', 'Audio channels must be an integer from 1 to 8.')
		}
		if (!Number.isInteger(frame.samplesPerChannel) || frame.samplesPerChannel <= 0) {
			throw new LiveError(
				'audio_frame_invalid',
				'Audio samplesPerChannel must be a positive integer.',
			)
		}
		if (
			frame.sequence !== undefined &&
			(!Number.isSafeInteger(frame.sequence) || frame.sequence < 0)
		) {
			throw new LiveError(
				'audio_frame_invalid',
				'Audio sequence must be a non-negative safe integer.',
			)
		}
		if (frame.timestampMs !== undefined && !Number.isFinite(frame.timestampMs)) {
			throw new LiveError('audio_frame_invalid', 'Audio timestampMs must be finite.')
		}
		const bytesPerSample = frame.format === 'pcm_s16le' ? 2 : frame.format === 'pcm_f32le' ? 4 : 0
		const expectedBytes = frame.samplesPerChannel * frame.channels * bytesPerSample
		if (bytesPerSample === 0 || frame.data.byteLength !== expectedBytes) {
			throw new LiveError(
				'audio_frame_invalid',
				`Audio data has ${frame.data.byteLength} bytes; the declared PCM shape requires ${expectedBytes}.`,
			)
		}
		const durationMs = (frame.samplesPerChannel / frame.sampleRateHz) * 1_000
		if (durationMs > this.options.maxFrameDurationMs) {
			throw new LiveError(
				'audio_frame_invalid',
				`Audio frame duration ${durationMs}ms exceeds the ${this.options.maxFrameDurationMs}ms limit.`,
			)
		}
		return durationMs
	}

	private validateVoiceActivityEvent(event: VoiceActivityEvent): void {
		if (event.type !== 'speech_start' && event.type !== 'speech_end') {
			throw new LiveError('invalid_driver_event', 'VAD emitted an unknown event type.')
		}
		if (!Number.isFinite(event.timestampMs)) {
			throw new LiveError('invalid_driver_event', 'VAD timestamps must be finite.')
		}
		if (
			event.probability !== undefined &&
			(!Number.isFinite(event.probability) || event.probability < 0 || event.probability > 1)
		) {
			throw new LiveError('invalid_driver_event', 'VAD probability must be between 0 and 1.')
		}
	}

	private validateTranscriptEvent(event: TranscriptEvent): void {
		if (event.type !== 'partial_transcript' && event.type !== 'final_transcript') {
			throw new LiveError(
				'invalid_driver_event',
				'Speech recognition emitted an unknown event type.',
			)
		}
		if (typeof event.text !== 'string') {
			throw new LiveError('invalid_driver_event', 'Speech recognition text must be a string.')
		}
		if (!Number.isFinite(event.timestampMs)) {
			throw new LiveError('invalid_driver_event', 'Speech recognition timestamps must be finite.')
		}
		if (
			event.confidence !== undefined &&
			(!Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1)
		) {
			throw new LiveError(
				'invalid_driver_event',
				'Speech recognition confidence must be between 0 and 1.',
			)
		}
		if (event.language !== undefined && typeof event.language !== 'string') {
			throw new LiveError('invalid_driver_event', 'Speech recognition language must be a string.')
		}
	}

	private validateOptions(): void {
		for (const [name, value] of Object.entries({
			audioBufferMs: this.options.audioBufferMs,
			closeTimeoutMs: this.options.closeTimeoutMs,
			endOfTurnTimeoutMs: this.options.endOfTurnTimeoutMs,
			maxFrameDurationMs: this.options.maxFrameDurationMs,
			maxSpeechDurationMs: this.options.maxSpeechDurationMs,
			speechBufferChars: this.options.speechBufferChars,
			speechChunkChars: this.options.speechChunkChars,
			speechMinimumChars: this.options.speechMinimumChars,
		})) {
			if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive.`)
		}
		if (this.options.speechMinimumChars > this.options.speechChunkChars) {
			throw new RangeError('speechMinimumChars cannot exceed speechChunkChars.')
		}
		if (this.options.speechChunkChars > this.options.speechBufferChars) {
			throw new RangeError('speechChunkChars cannot exceed speechBufferChars.')
		}
	}

	private requireAgent(): LiveAgent {
		if (this.stateValue === 'closed') {
			throw new LiveError('session_closed', 'The live session is closed.')
		}
		if (!this.agent) {
			throw new LiveError(
				'session_not_started',
				'Call start() with a LiveAgent before running a turn.',
			)
		}
		return this.agent
	}

	private isCurrent(record: TurnRecord): boolean {
		return this.currentTurn === record && this.turnGeneration === record.generation
	}

	private emit(event: LiveSessionEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch {
				// Observers are isolated from the realtime pipeline by contract.
			}
		}
	}

	private setState(state: LiveSessionState): void {
		if (this.stateValue === state) return
		const previous = this.stateValue
		this.stateValue = state
		this.emit({ previous, state, type: 'state_changed' })
	}

	private async settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			return await Promise.race([
				promise.then(
					() => true,
					() => true,
				),
				new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), timeoutMs)
				}),
			])
		} finally {
			if (timer) clearTimeout(timer)
		}
	}
}
