// Runs inside a worker thread. Only erasable TypeScript and type-only imports here: the file is
// loaded as written when tested and as compiled output when packaged.
import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'
import type {
	ListeningWorkerData,
	ListeningWorkerRequest,
	ListeningWorkerResponse,
	VadFeedResult,
} from './local-listening-protocol.js'

interface NativeVad {
	acceptWaveform(samples: Float32Array): void
	isEmpty(): boolean
	isDetected(): boolean
	front(external?: boolean): { start: number; samples: Float32Array }
	pop(): void
	flush(): void
}
interface NativeRecognizer {
	createStream(): { acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void }
	decode(stream: unknown): void
	getResult(stream: unknown): { text: string }
}
interface Native {
	Vad: new (config: unknown, bufferSeconds: number) => NativeVad
	OfflineRecognizer: new (config: unknown) => NativeRecognizer
}

const data = workerData as ListeningWorkerData
const port = parentPort
if (!port) throw new Error('The listening worker must run in a worker thread.')

let native: Native | undefined
const load = (): Native => {
	native ??= createRequire(import.meta.url)('sherpa-onnx-node') as Native
	return native
}

const streams = new Map<number, NativeVad>()
let recognizer: NativeRecognizer | undefined

const openVad = (): NativeVad =>
	new (load().Vad)(
		{
			sileroVad: {
				model: data.paths.voiceActivity,
				threshold: 0.5,
				minSilenceDuration: 0.25,
				minSpeechDuration: 0.1,
				windowSize: 512,
				maxSpeechDuration: 30,
			},
			sampleRate: 16000,
			numThreads: 1,
			provider: 'cpu',
			debug: 0,
		},
		35,
	)

const drain = (vad: NativeVad, detectedBeforeDrain?: boolean): VadFeedResult => {
	const segments: VadFeedResult['segments'] = []
	while (!vad.isEmpty()) {
		const front = vad.front(false)
		segments.push({ start: front.start, length: front.samples.length })
		vad.pop()
	}
	return { detected: detectedBeforeDrain ?? vad.isDetected(), segments }
}

const stream = (id: number): NativeVad => {
	const vad = streams.get(id)
	if (!vad) throw new Error('This listening session has ended.')
	return vad
}

const handle = (
	request: ListeningWorkerRequest,
): Omit<ListeningWorkerResponse & { ok: true }, 'id' | 'ok'> => {
	switch (request.type) {
		case 'vad-open':
			if (data.role !== 'voiceActivity') throw new Error('Wrong listening worker.')
			streams.set(request.stream, openVad())
			return {}
		case 'vad-feed': {
			const vad = stream(request.stream)
			vad.acceptWaveform(request.samples)
			return { vad: drain(vad) }
		}
		case 'vad-flush': {
			const vad = stream(request.stream)
			vad.flush()
			return { vad: drain(vad, false) }
		}
		case 'vad-close':
			streams.delete(request.stream)
			return {}
		case 'transcribe': {
			if (data.role !== 'recognizer') throw new Error('Wrong listening worker.')
			recognizer ??= new (load().OfflineRecognizer)({
				featConfig: { sampleRate: 16000, featureDim: 80 },
				modelConfig: {
					whisper: {
						encoder: data.paths.encoder,
						decoder: data.paths.decoder,
						language: data.language,
						task: 'transcribe',
						tailPaddings: -1,
					},
					tokens: data.paths.tokens,
					numThreads: data.threads,
					provider: 'cpu',
					debug: 0,
				},
			})
			const input = recognizer.createStream()
			input.acceptWaveform({ sampleRate: 16000, samples: request.samples })
			recognizer.decode(input)
			return { text: recognizer.getResult(input).text.trim() }
		}
	}
}

port.on('message', (request: ListeningWorkerRequest) => {
	let response: ListeningWorkerResponse
	try {
		response = { id: request.id, ok: true, ...handle(request) }
	} catch (error) {
		response = {
			id: request.id,
			ok: false,
			message: error instanceof Error ? error.message : 'Listening failed.',
		}
	}
	port.postMessage(response)
})
