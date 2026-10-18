import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalListeningState } from '../shared/local-listening-protocol.js'
import type { VoiceInputEvent } from '../shared/voice-input-protocol.js'
import { AsyncChannel, type ListeningFrame } from './local-listening-stream.js'
import {
	type VoiceActivity,
	type VoiceConversation,
	type VoiceDetectorLike,
	VoiceInputManager,
	type VoiceRecognizerLike,
} from './voice-input.js'

type VadEvent = { type: 'speech_start' | 'speech_end'; timestampMs: number }
type AsrEvent = { type: 'final_transcript'; text: string; timestampMs: number }

/** Stands in for the two listening adapters: the test says what they report, and sees the frames. */
class FakeAdapters {
	readonly frames: ListeningFrame[] = []
	readonly vad = new AsyncChannel<VadEvent>()
	readonly asr = new AsyncChannel<AsrEvent>()
	private drained = 0
	readonly detector: VoiceDetectorLike = {
		detect: (frames, context) => this.run(frames, context.signal, this.vad),
	}
	readonly recognizer: VoiceRecognizerLike = {
		transcribe: (frames, context) => this.run(frames, context.signal, this.asr),
	}
	private async *run<T>(
		frames: AsyncIterable<ListeningFrame>,
		signal: AbortSignal,
		out: AsyncChannel<T>,
	): AsyncGenerator<T> {
		signal.addEventListener('abort', () => out.close(), { once: true })
		void (async () => {
			for await (const frame of frames) {
				this.drained++
				if (this.drained % 2 === 1) this.frames.push(frame)
			}
		})()
		yield* out
	}
	/** One spoken segment as the detector and recognizer would report it. */
	say(text: string, startMs: number, endMs: number): void {
		this.vad.push({ type: 'speech_start', timestampMs: startMs })
		this.vad.push({ type: 'speech_end', timestampMs: endMs })
		this.asr.push({ type: 'final_transcript', text, timestampMs: (startMs + endMs) / 2 })
	}
}

const readyState: LocalListeningState = {
	installation: 'ready',
	engine: 'ready',
	device: 'cpu',
	downloadBytes: 1,
	diskBytes: 1,
}

function setup(
	options: { consent?: boolean; installation?: LocalListeningState['installation'] } = {},
) {
	const adapters = new FakeAdapters()
	const events: { windowId: string; event: VoiceInputEvent }[] = []
	const calls: string[] = []
	const activity: VoiceActivity = { running: false, waitingOnPerson: false }
	const conversation: VoiceConversation = {
		activity: () => ({ ...activity }),
		cancel: vi.fn(async (id: string) => {
			calls.push(`cancel:${id}`)
		}),
		sendSpoken: vi.fn(async (id: string, text: string) => {
			calls.push(`send:${id}:${text}`)
		}),
	}
	const owners = new Map<string, Set<string>>([['w1', new Set(['s1', 's2'])]])
	const manager = new VoiceInputManager({
		conversation,
		createAdapters: () => ({ detector: adapters.detector, recognizer: adapters.recognizer }),
		assertOwner: (windowId, sessionId) => {
			if (!owners.get(windowId)?.has(sessionId)) throw new Error('not owner')
		},
		deliver: (windowId, event) => events.push({ windowId, event }),
		consentAccepted: () => options.consent ?? true,
		engineState: async () => ({ ...readyState, installation: options.installation ?? 'ready' }),
	})
	return { adapters, manager, events, calls, activity, conversation, owners }
}

const chunk = (samples = 1600, value = 0.1) => new Float32Array(samples).fill(value)
const ofType = (events: { event: VoiceInputEvent }[], type: string) =>
	events.filter((item) => item.event.type === type).map((item) => item.event)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('starting', () => {
	it('needs the person’s agreement first', async () => {
		const { manager } = setup({ consent: false })
		await expect(manager.start('w1', 's1')).rejects.toThrow('Turn on voice input first')
	})
	it('needs the downloaded engine', async () => {
		const { manager } = setup({ installation: 'missing' })
		await expect(manager.start('w1', 's1')).rejects.toThrow('isn’t downloaded')
	})
	it('only for a conversation the window owns', async () => {
		const { manager } = setup()
		await expect(manager.start('w1', 'other')).rejects.toThrow('not owner')
		await expect(manager.start('w2', 's1')).rejects.toThrow('not owner')
		await expect(manager.start('w1', 7)).rejects.toThrow('Invalid voice conversation')
	})
})

describe('audio ingress', () => {
	it('feeds checked frames to both adapters on a monotonic 16 kHz timeline', async () => {
		const { manager, adapters } = setup()
		await manager.start('w1', 's1')
		manager.audio('w1', 's1', chunk())
		manager.audio('w1', 's1', chunk(800))
		manager.audio('w1', 's1', chunk())
		await vi.advanceTimersByTimeAsync(0)
		expect(adapters.frames.map((frame) => frame.timestampMs)).toEqual([0, 100, 150])
		for (const frame of adapters.frames) {
			expect(frame.format).toBe('pcm_f32le')
			expect(frame.sampleRateHz).toBe(16_000)
			expect(frame.channels).toBe(1)
			expect(frame.data.byteLength).toBe(frame.samplesPerChannel * 4)
		}
		await manager.stop('w1')
	})

	it.each([
		['not a Float32Array', [0.1, 0.2]],
		['an Int16Array', new Int16Array(160)],
		['empty', new Float32Array(0)],
		['too long', new Float32Array(8_001)],
		['not finite', Float32Array.of(0.1, Number.NaN)],
		['out of range', Float32Array.of(0.1, 3)],
	])('rejects audio that is %s', async (_name, value) => {
		const { manager } = setup()
		await manager.start('w1', 's1')
		expect(() => manager.audio('w1', 's1', value)).toThrow(/Invalid voice input audio/)
		await manager.stop('w1')
	})

	it('rejects a chunk for another conversation or a window that is not listening', async () => {
		const { manager } = setup()
		expect(() => manager.audio('w1', 's1', chunk())).toThrow('isn’t listening')
		await manager.start('w1', 's1')
		expect(() => manager.audio('w1', 's2', chunk())).toThrow('isn’t listening')
		expect(() => manager.audio('w2', 's1', chunk())).toThrow('isn’t listening')
		await manager.stop('w1')
	})

	it('stops listening when the window no longer owns the conversation', async () => {
		const { manager, events, owners } = setup()
		await manager.start('w1', 's1')
		owners.get('w1')?.delete('s1')
		expect(() => manager.audio('w1', 's1', chunk())).toThrow('not owner')
		await vi.advanceTimersByTimeAsync(0)
		expect(ofType(events, 'ended')).toEqual([
			{ type: 'ended', sessionId: 's1', reason: 'conversation' },
		])
		expect(manager.has('w1')).toBe(false)
	})

	it('refuses audio that arrives far faster than it plays and ends the session', async () => {
		const { manager, events } = setup()
		await manager.start('w1', 's1')
		let accepted = 0
		for (;;) {
			try {
				manager.audio('w1', 's1', chunk(8_000))
				accepted++
			} catch (error) {
				expect((error as Error).message).toContain('too fast')
				break
			}
		}
		// Two seconds of budget at half a second per chunk.
		expect(accepted).toBe(4)
		await vi.advanceTimersByTimeAsync(0)
		expect(ofType(events, 'ended')).toEqual([{ type: 'ended', sessionId: 's1', reason: 'error' }])
	})

	it('accepts real-time audio indefinitely', async () => {
		const { manager } = setup()
		await manager.start('w1', 's1')
		for (let at = 0; at < 100; at++) {
			manager.audio('w1', 's1', chunk())
			await vi.advanceTimersByTimeAsync(100)
		}
		expect(manager.has('w1')).toBe(true)
		await manager.stop('w1')
	})
})

describe('a finished spoken message', () => {
	it('is sent the way typed text is, once the person stops', async () => {
		const { manager, adapters, calls, events } = setup()
		await manager.start('w1', 's1')
		adapters.say('Projeyi derle', 0, 1000)
		await vi.advanceTimersByTimeAsync(799)
		expect(calls).toEqual([])
		await vi.advanceTimersByTimeAsync(1)
		expect(calls).toEqual(['send:s1:Projeyi derle'])
		expect(ofType(events, 'sent')).toEqual([{ type: 'sent', sessionId: 's1' }])
		await manager.stop('w1')
	})

	it('joins segments said close together into one message', async () => {
		const { manager, adapters, calls } = setup()
		await manager.start('w1', 's1')
		adapters.say('Dosyayı aç', 0, 1000)
		await vi.advanceTimersByTimeAsync(400)
		adapters.say('ve oku', 1400, 2000)
		await vi.advanceTimersByTimeAsync(800)
		expect(calls).toEqual(['send:s1:Dosyayı aç ve oku'])
		await manager.stop('w1')
	})

	it('a stop word alone stops the running reply and sends nothing', async () => {
		const { manager, adapters, calls, events, activity } = setup()
		activity.running = true
		await manager.start('w1', 's1')
		adapters.say('Dur.', 0, 600)
		await vi.advanceTimersByTimeAsync(800)
		expect(calls).toEqual(['cancel:s1'])
		expect(ofType(events, 'reply-stopped')).toEqual([{ type: 'reply-stopped', sessionId: 's1' }])
		expect(ofType(events, 'sent')).toEqual([])
		await manager.stop('w1')
	})

	it('a stop word with nothing running does nothing at all', async () => {
		const { manager, adapters, calls, events } = setup()
		await manager.start('w1', 's1')
		adapters.say('İptal', 0, 600)
		await vi.advanceTimersByTimeAsync(800)
		expect(calls).toEqual([])
		expect(ofType(events, 'sent')).toEqual([])
		expect(ofType(events, 'reply-stopped')).toEqual([])
		await manager.stop('w1')
	})

	it('a stop word still stops the reply while a question is waiting', async () => {
		const { manager, adapters, calls, activity } = setup()
		activity.running = true
		activity.waitingOnPerson = true
		await manager.start('w1', 's1')
		adapters.say('stop', 0, 600)
		await vi.advanceTimersByTimeAsync(800)
		expect(calls).toEqual(['cancel:s1'])
		await manager.stop('w1')
	})

	it('is held, not sent, while a permission or decision prompt is waiting', async () => {
		const { manager, adapters, calls, events, activity } = setup()
		activity.running = true
		activity.waitingOnPerson = true
		await manager.start('w1', 's1')
		adapters.say('Evet, onaylıyorum', 0, 1500)
		await vi.advanceTimersByTimeAsync(800)
		expect(calls).toEqual([])
		expect(ofType(events, 'held')).toEqual([
			{ type: 'held', sessionId: 's1', text: 'Evet, onaylıyorum' },
		])
		expect(ofType(events, 'sent')).toEqual([])
		await manager.stop('w1')
	})

	it('sends again once the question is answered', async () => {
		const { manager, adapters, calls, activity } = setup()
		activity.waitingOnPerson = true
		await manager.start('w1', 's1')
		adapters.say('Bir şey söyledim', 0, 1000)
		await vi.advanceTimersByTimeAsync(800)
		expect(calls).toEqual([])
		activity.waitingOnPerson = false
		adapters.say('Tekrar söylüyorum', 3000, 4000)
		await vi.advanceTimersByTimeAsync(800)
		expect(calls).toEqual(['send:s1:Tekrar söylüyorum'])
		await manager.stop('w1')
	})

	it('says plainly when the message could not be sent, with what was heard', async () => {
		const { manager, adapters, events, conversation } = setup()
		vi.mocked(conversation.sendSpoken).mockRejectedValueOnce(new Error('Error: ECONNRESET at x'))
		await manager.start('w1', 's1')
		adapters.say('Bunu gönder', 0, 1000)
		await vi.advanceTimersByTimeAsync(800)
		expect(ofType(events, 'not-sent')).toEqual([
			{ type: 'not-sent', sessionId: 's1', text: 'Bunu gönder' },
		])
		expect(JSON.stringify(events)).not.toContain('ECONNRESET')
		await manager.stop('w1')
	})

	it('sends two messages in the order they were said', async () => {
		const { manager, adapters, calls, conversation } = setup()
		let release: (() => void) | undefined
		vi.mocked(conversation.sendSpoken).mockImplementationOnce(async (id, text) => {
			await new Promise<void>((resolve) => {
				release = resolve
			})
			calls.push(`send:${id}:${text}`)
		})
		await manager.start('w1', 's1')
		adapters.say('birinci', 0, 1000)
		await vi.advanceTimersByTimeAsync(800)
		adapters.say('ikinci', 3000, 4000)
		await vi.advanceTimersByTimeAsync(800)
		expect(calls).toEqual([])
		release?.()
		await vi.advanceTimersByTimeAsync(0)
		expect(calls).toEqual(['send:s1:birinci', 'send:s1:ikinci'])
		await manager.stop('w1')
	})
})

describe('what the person sees while listening', () => {
	it('reports hearing, transcribing, then listening again', async () => {
		const { manager, adapters, events } = setup()
		await manager.start('w1', 's1')
		adapters.vad.push({ type: 'speech_start', timestampMs: 0 })
		await vi.advanceTimersByTimeAsync(0)
		adapters.vad.push({ type: 'speech_end', timestampMs: 1000 })
		await vi.advanceTimersByTimeAsync(0)
		adapters.asr.push({ type: 'final_transcript', text: 'merhaba', timestampMs: 500 })
		await vi.advanceTimersByTimeAsync(800)
		expect(ofType(events, 'phase').map((event) => (event as { phase: string }).phase)).toEqual([
			'listening',
			'hearing',
			'transcribing',
			'listening',
		])
		await manager.stop('w1')
	})
})

describe('lifecycle', () => {
	it('stops on request, telling the window', async () => {
		const { manager, events } = setup()
		await manager.start('w1', 's1')
		await manager.stop('w1')
		expect(manager.has('w1')).toBe(false)
		expect(ofType(events, 'ended')).toEqual([{ type: 'ended', sessionId: 's1', reason: 'stopped' }])
		expect(() => manager.audio('w1', 's1', chunk())).toThrow('isn’t listening')
	})

	it('starting another conversation ends the first', async () => {
		const { manager, events } = setup()
		await manager.start('w1', 's1')
		await manager.start('w1', 's2')
		expect(ofType(events, 'ended')).toEqual([
			{ type: 'ended', sessionId: 's1', reason: 'conversation' },
		])
		expect(() => manager.audio('w1', 's1', chunk())).toThrow('isn’t listening')
		expect(() => manager.audio('w1', 's2', chunk())).not.toThrow()
		await manager.stop('w1')
	})

	it('stops when its window closes', async () => {
		const { manager, events } = setup()
		await manager.start('w1', 's1')
		manager.stopWindow('w1')
		await vi.advanceTimersByTimeAsync(0)
		expect(ofType(events, 'ended')).toEqual([{ type: 'ended', sessionId: 's1', reason: 'window' }])
	})

	it.each(['quit', 'sleep'] as const)('stops everything on %s', async (reason) => {
		const { manager, events } = setup()
		await manager.start('w1', 's1')
		await manager.stopAll(reason)
		expect(manager.has('w1')).toBe(false)
		expect(ofType(events, 'ended')).toEqual([{ type: 'ended', sessionId: 's1', reason }])
	})

	it('stops when the listening engine is removed', async () => {
		const { manager, events } = setup()
		await manager.start('w1', 's1')
		manager.noteEngine({ ...readyState, installation: 'missing' })
		await vi.advanceTimersByTimeAsync(0)
		expect(manager.has('w1')).toBe(false)
		expect(ofType(events, 'ended')).toEqual([
			{ type: 'ended', sessionId: 's1', reason: 'uninstalled' },
		])
	})

	it('ends with an error when the models fail, and stops sending', async () => {
		const { manager, adapters, events } = setup()
		await manager.start('w1', 's1')
		adapters.asr.fail(new Error('boom'))
		await vi.advanceTimersByTimeAsync(0)
		expect(ofType(events, 'ended')).toEqual([{ type: 'ended', sessionId: 's1', reason: 'error' }])
		expect(manager.has('w1')).toBe(false)
	})

	it('no message completes after listening has stopped', async () => {
		const { manager, adapters, calls } = setup()
		await manager.start('w1', 's1')
		adapters.say('geç kaldı', 0, 1000)
		await vi.advanceTimersByTimeAsync(300)
		await manager.stop('w1')
		await vi.advanceTimersByTimeAsync(5000)
		expect(calls).toEqual([])
	})

	it('holds the engine busy flag for a message that waits on the recognizer', async () => {
		const { manager, adapters, calls } = setup()
		await manager.start('w1', 's1')
		manager.noteEngine({ ...readyState, engine: 'working' })
		adapters.vad.push({ type: 'speech_start', timestampMs: 0 })
		adapters.vad.push({ type: 'speech_end', timestampMs: 1000 })
		await vi.advanceTimersByTimeAsync(10_000)
		expect(calls).toEqual([])
		adapters.asr.push({ type: 'final_transcript', text: 'uzun sürdü', timestampMs: 500 })
		manager.noteEngine({ ...readyState, engine: 'ready' })
		await vi.advanceTimersByTimeAsync(0)
		expect(calls).toEqual(['send:s1:uzun sürdü'])
		await manager.stop('w1')
	})
})
