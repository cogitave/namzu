import { expect, it } from 'vitest'
import {
	type ListeningWorkerHandle,
	WorkerListeningEngine,
	unpackedWorkerPath,
} from './local-listening-engine.js'
import type {
	ListeningWorkerData,
	ListeningWorkerRequest,
	ListeningWorkerResponse,
} from './local-listening-protocol.js'

class FakeWorker implements ListeningWorkerHandle {
	requests: ListeningWorkerRequest[] = []
	terminated = false
	private listeners: Record<string, ((value: never) => void)[]> = {}
	constructor(readonly data: ListeningWorkerData) {}
	postMessage(message: ListeningWorkerRequest): void {
		this.requests.push(message)
	}
	on(event: string, listener: (value: never) => void): this {
		const list = this.listeners[event] ?? []
		this.listeners[event] = list
		list.push(listener)
		return this
	}
	async terminate(): Promise<void> {
		this.terminated = true
	}
	reply(response: ListeningWorkerResponse): void {
		for (const listener of this.listeners.message ?? []) listener(response as never)
	}
	crash(error: Error): void {
		for (const listener of this.listeners.error ?? []) listener(error as never)
	}
}

const paths = { encoder: 'e', decoder: 'd', tokens: 't', voiceActivity: 'v' }
function engine() {
	const workers: FakeWorker[] = []
	const instance = new WorkerListeningEngine({
		paths,
		workerUrl: new URL('file:///worker.js'),
		createWorker: (_url, data) => {
			const worker = new FakeWorker(data)
			workers.push(worker)
			return worker
		},
	})
	const role = (name: string) => workers.filter((worker) => worker.data.role === name)
	return { instance, workers, role }
}
const never = () => new AbortController().signal
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

it('starts no thread until something is asked', async () => {
	const { instance, workers } = engine()
	expect(workers).toHaveLength(0)
	await instance.dispose()
	expect(workers).toHaveLength(0)
})

it('runs voice activity and speech on separate threads with their own role and the pinned settings', async () => {
	const { instance, role } = engine()
	const opening = instance.openVad()
	const vad = role('voiceActivity')[0] as FakeWorker
	vad.reply({ id: 1, ok: true })
	await opening
	const text = instance.transcribe(new Float32Array(100), never())
	await tick()
	const speech = role('recognizer')[0] as FakeWorker
	expect(speech).not.toBe(vad)
	expect(speech.data).toMatchObject({ role: 'recognizer', threads: 4, language: 'tr', paths })
	speech.reply({ id: 1, ok: true, text: 'merhaba' })
	expect(await text).toBe('merhaba')
})

it('feeds a stream, returns the segments and tells the thread when the stream closes', async () => {
	const { instance, role } = engine()
	const opening = instance.openVad()
	const vad = role('voiceActivity')[0] as FakeWorker
	vad.reply({ id: 1, ok: true })
	const stream = await opening
	const feeding = stream.feed(new Float32Array(1_600))
	expect(vad.requests[1]).toMatchObject({ type: 'vad-feed', stream: 1 })
	vad.reply({ id: 2, ok: true, vad: { detected: true, segments: [{ start: 0, length: 10 }] } })
	expect(await feeding).toEqual({ detected: true, segments: [{ start: 0, length: 10 }] })
	stream.close()
	expect(vad.requests[2]).toMatchObject({ type: 'vad-close', stream: 1 })
	await expect(stream.feed(new Float32Array(10))).rejects.toThrow(/has ended/)
})

it('bounds a voice-activity piece, the streams open at once, and an utterance', async () => {
	const { instance, role } = engine()
	const opening = instance.openVad()
	;(role('voiceActivity')[0] as FakeWorker).reply({ id: 1, ok: true })
	const stream = await opening
	await expect(stream.feed(new Float32Array(16_001))).rejects.toThrow(/too long/)
	await expect(instance.transcribe(new Float32Array(33 * 16_000 + 1), never())).rejects.toThrow(
		/too long/,
	)
	const vad = role('voiceActivity')[0] as FakeWorker
	for (let index = 2; index <= 4; index++) {
		const next = instance.openVad()
		vad.reply({ id: vad.requests.length, ok: true })
		await next
	}
	await expect(instance.openVad()).rejects.toThrow(/Too many/)
})

it('sends one recognition at a time and refuses to queue without bound', async () => {
	const { instance, role } = engine()
	const results = Array.from({ length: 9 }, () =>
		instance.transcribe(new Float32Array(10), never()),
	)
	await tick()
	const speech = role('recognizer')[0] as FakeWorker
	expect(speech.requests).toHaveLength(1)
	await expect(instance.transcribe(new Float32Array(10), never())).rejects.toThrow(/busy/)
	for (let index = 1; index <= 9; index++) {
		speech.reply({ id: index, ok: true, text: `t${index}` })
		await tick()
	}
	expect(await Promise.all(results)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'])
})

it('a queued recognition that is aborted is never sent', async () => {
	const { instance, role } = engine()
	const first = instance.transcribe(new Float32Array(10), never())
	const controller = new AbortController()
	const second = instance.transcribe(new Float32Array(10), controller.signal)
	const third = instance.transcribe(new Float32Array(10), never())
	await tick()
	controller.abort()
	await expect(second).rejects.toMatchObject({ name: 'AbortError' })
	const speech = role('recognizer')[0] as FakeWorker
	speech.reply({ id: 1, ok: true, text: 'one' })
	await tick()
	expect(speech.requests).toHaveLength(2)
	speech.reply({ id: 2, ok: true, text: 'three' })
	expect([await first, await third]).toEqual(['one', 'three'])
})

it('aborting the one being decoded rejects at once, drops its text and serves the next', async () => {
	const { instance, role } = engine()
	const controller = new AbortController()
	const running = instance.transcribe(new Float32Array(10), controller.signal)
	const next = instance.transcribe(new Float32Array(10), never())
	await tick()
	controller.abort()
	await expect(running).rejects.toMatchObject({ name: 'AbortError' })
	const speech = role('recognizer')[0] as FakeWorker
	speech.reply({ id: 1, ok: true, text: 'late' })
	await tick()
	speech.reply({ id: 2, ok: true, text: 'next' })
	expect(await next).toBe('next')
	await expect(instance.transcribe(new Float32Array(10), controller.signal)).rejects.toMatchObject({
		name: 'AbortError',
	})
})

it('a crashed thread fails what it was doing and starts fresh for the next request', async () => {
	const { instance, role } = engine()
	const failing = instance.transcribe(new Float32Array(10), never())
	await tick()
	;(role('recognizer')[0] as FakeWorker).crash(new Error('native failure'))
	await expect(failing).rejects.toThrow('native failure')
	const retry = instance.transcribe(new Float32Array(10), never())
	await tick()
	expect(role('recognizer')).toHaveLength(2)
	;(role('recognizer')[1] as FakeWorker).reply({ id: 2, ok: true, text: 'again' })
	expect(await retry).toBe('again')
})

it("passes the worker's own failure message through", async () => {
	const { instance, role } = engine()
	const result = instance.transcribe(new Float32Array(10), never())
	await tick()
	;(role('recognizer')[0] as FakeWorker).reply({ id: 1, ok: false, message: 'Model file missing' })
	await expect(result).rejects.toThrow('Model file missing')
})

it('unloading the speech model ends only that thread; dispose ends both and refuses more work', async () => {
	const { instance, role } = engine()
	const opening = instance.openVad()
	;(role('voiceActivity')[0] as FakeWorker).reply({ id: 1, ok: true })
	await opening
	const text = instance.transcribe(new Float32Array(10), never())
	await tick()
	;(role('recognizer')[0] as FakeWorker).reply({ id: 1, ok: true, text: 'x' })
	await text
	await instance.unloadRecognizer()
	expect(role('recognizer')[0]?.terminated).toBe(true)
	expect(role('voiceActivity')[0]?.terminated).toBe(false)
	await instance.dispose()
	expect(role('voiceActivity')[0]?.terminated).toBe(true)
	await expect(instance.transcribe(new Float32Array(10), never())).rejects.toThrow(/closed/)
	await expect(instance.openVad()).rejects.toThrow(/closed/)
})

it('uses the unpacked copy of the worker inside a packaged app', () => {
	expect(unpackedWorkerPath('C:\\Namzu\\resources\\app.asar\\dist\\main\\w.js')).toBe(
		'C:\\Namzu\\resources\\app.asar.unpacked\\dist\\main\\w.js',
	)
	expect(unpackedWorkerPath('/opt/n/resources/app.asar/dist/main/w.js')).toBe(
		'/opt/n/resources/app.asar.unpacked/dist/main/w.js',
	)
	expect(unpackedWorkerPath('/repo/dist/main/w.js')).toBe('/repo/dist/main/w.js')
})
